import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startSource} from '../provider/server.mjs';
import {createClient} from '../src/source.mjs';
import {collect} from '../src/reader.mjs';
import {openArchive} from '../src/archive.mjs';
import {startIntake} from '../src/app.mjs';
import {foldNotices,latestRelations} from '../src/relations.mjs';

async function environment(run){
  const directory=await mkdtemp(join(tmpdir(),'relations-test-'));
  const source=await startSource();
  try{await run({directory,source});}
  finally{await source.close();await rm(directory,{recursive:true,force:true});}
}

async function collectInto(archive,origin){
  const client=createClient(origin);
  const records=await collect(client,archive.records());
  await archive.commit(records,client.exchanges);
  return records;
}

test('关系型收件分清运输段、单据修订与实物装载身份',()=>environment(async({directory,source})=>{
  const archive=await openArchive(directory);
  await collectInto(archive,source.origin);
  const records=archive.records();
  const notice=records.find(record=>record.type==='notice');
  assert.equal(notice.id,'notice:C1:L1:n1');
  assert.equal(notice.leg,'L1');
  assert.equal(notice.declaration.revision,1,'单据修订号不被归档摘要覆盖');
  const load=records.find(record=>record.type==='load');
  assert.equal(load.id,'load:C1:L1:c1');
  assert.equal(load.load.version,1);
  const relation=records.find(record=>record.type==='relation');
  assert.equal(relation.id,'relation:C1:L1');
  assert.equal(relation.sequence,1);
  assert.deepEqual(relation.head,{noticeId:'n1',revision:1});
}));

test('拆并声明与箱单保留来源凭据',()=>environment(async({directory,source})=>{
  const archive=await openArchive(directory);
  await collectInto(archive,source.origin);
  const receipts=archive.exchanges();
  const declared=archive.records().filter(record=>record.type==='notice'||record.type==='load');
  assert.ok(declared.length>=2);
  for(const record of declared){
    const receipt=receipts.find(exchange=>exchange.hash===record.source.hash);
    assert.ok(receipt,record.id+' 回指归档凭据');
    assert.equal(receipt.url,record.source.url);
  }
}));

test('合票修订后货物只归属新主单，每个可见版本自洽',()=>environment(async({directory,source})=>{
  const archive=await openArchive(directory);
  await collectInto(archive,source.origin);
  source.setPhase('regroup');
  await collectInto(archive,source.origin);
  const versions=archive.records().filter(record=>record.type==='relation');
  assert.equal(versions.length,2);
  for(const version of versions){
    const cargo=version.placements.filter(placement=>placement.cargoId==='c1');
    assert.equal(cargo.length,1,'任一可见版本内货物只归属一张单据');
    const regrouped=version.bills.some(bill=>bill.billId==='B2'&&bill.status==='active');
    if(regrouped)assert.equal(cargo[0].bill,'B2','新主单与货物归属在同一版本内出现');
  }
  const latest=versions.find(record=>record.sequence===2);
  assert.equal(latest.placements[0].bill,'B2');
  assert.equal(latest.placements[0].movedBy,'n2');
  assert.equal(latest.bills.find(bill=>bill.billId==='H1').status,'cancelled');
  assert.equal(latest.bills.find(bill=>bill.billId==='B2').declaredBy,'n2');
  assert.deepEqual(latest.loads,[{cargoId:'c1',container:'box1',packages:12,version:1}],'旧分单撤销不删除货物与箱单');
  assert.deepEqual(latest.notices,[{noticeId:'n1',revision:1},{noticeId:'n2',revision:2}],'折叠链跨两次收件保持连续');
  assert.deepEqual(latest.pending,[]);
}));

test('旧分单撤销不删除货物，未见迁移声明时记为未决',()=>{
  const folded=foldNotices([
    {noticeId:'n1',leg:'L1',revision:1,replaces:null,
      bills:[{billId:'B1',kind:'master',status:'active',parent:null},{billId:'H1',kind:'house',status:'active',parent:'B1'}],
      moves:[{cargoId:'c1',from:null,to:'H1'}]},
    {noticeId:'n2',leg:'L1',revision:2,replaces:'n1',
      bills:[{billId:'H1',kind:'house',status:'cancelled',parent:'B1'}],
      moves:[]}
  ]);
  assert.equal(folded.placements.length,1);
  assert.equal(folded.placements[0].bill,'H1','撤销单据不清空货物归属');
  assert.equal(folded.pending.length,1);
  assert.equal(folded.pending[0].code,'cargo-on-cancelled-bill');
  assert.equal(folded.pending[0].cargoId,'c1');
});

test('缺少关联票据、断链与迁移不符都记为未决原因',()=>{
  const folded=foldNotices([
    {noticeId:'n2',leg:'L1',revision:2,replaces:'n1',bills:[],moves:[{cargoId:'c1',from:'H1',to:'B9'}]}
  ]);
  assert.deepEqual(folded.pending.map(entry=>entry.code),['notice-gap','move-from-mismatch','bill-missing']);
  assert.equal(folded.placements[0].bill,'B9','显式迁移声明仍照登，关系不靠猜');
});

test('缺少箱单时登记未决原因并保留已归档装载，补发后接着收件',()=>environment(async({directory,source})=>{
  const archive=await openArchive(directory);
  await collectInto(archive,source.origin);
  source.setPhase('missing-load');
  await collectInto(archive,source.origin);
  let latest=latestRelations(archive.records())[0];
  assert.equal(latest.sequence,2);
  assert.equal(latest.pending.length,1);
  assert.equal(latest.pending[0].code,'load-missing');
  assert.equal(latest.pending[0].cargoId,'c1');
  assert.match(latest.pending[0].detail,/箱单补发中/);
  assert.deepEqual(latest.loads,[{cargoId:'c1',container:'box1',packages:12,version:1}],'实物装载身份独立，已归档箱单保留');
  const receipt=archive.exchanges().find(exchange=>exchange.hash===latest.pending[0].source.hash);
  assert.equal(receipt.status,404,'未决原因回指来源凭据');
  source.setPhase('normal');
  await collectInto(archive,source.origin);
  latest=latestRelations(archive.records())[0];
  assert.equal(latest.sequence,3);
  assert.deepEqual(latest.pending,[]);
  assert.deepEqual(latest.loads,[{cargoId:'c1',container:'box1',packages:12,version:1}]);
}));

test('相同资料重放不产生新的关系版本',()=>environment(async({directory,source})=>{
  const archive=await openArchive(directory);
  await collectInto(archive,source.origin);
  const before=archive.records().length;
  await collectInto(archive,source.origin);
  assert.equal(archive.records().length,before);
}));

test('接收中断不产生半截状态，恢复后接着补收',()=>environment(async({directory,source})=>{
  const archive=await openArchive(directory);
  const inner=createClient(source.origin);
  let calls=0;
  const flaky=async path=>{calls+=1;if(calls===2)throw new Error('连接中断');return inner(path);};
  flaky.exchanges=inner.exchanges;
  await assert.rejects(()=>collect(flaky),/连接中断/);
  assert.equal(archive.records().length,0);
  assert.equal(archive.exchanges().length,0);
  await collectInto(archive,source.origin);
  const latest=latestRelations(archive.records())[0];
  assert.equal(latest.placements[0].bill,'H1');
  assert.deepEqual(latest.pending,[]);
}));

test('关系只来自显式声明，不靠号码相近或数量相等猜测',()=>environment(async({directory,source})=>{
  const archive=await openArchive(directory);
  await collectInto(archive,source.origin);
  const latest=latestRelations(archive.records())[0];
  assert.ok(!latest.placements.some(placement=>placement.bill==='B1'),'主单与货物件数相同也不建立归属');
  assert.equal(latest.bills.find(bill=>bill.billId==='B1').parent,null);
  assert.equal(latest.bills.find(bill=>bill.billId==='H1').parent,'B1');
  assert.ok(latest.placements.every(placement=>latest.notices.some(notice=>notice.noticeId===placement.movedBy)));
}));

test('未决原因通过查询接口交给资料岗核对',()=>environment(async({directory,source})=>{
  const intake=await startIntake({origin:source.origin,directory});
  try{
    source.setPhase('missing-load');
    assert.equal((await fetch(intake.origin+'/collect',{method:'POST'})).status,200);
    const pending=await(await fetch(intake.origin+'/pending')).json();
    assert.equal(pending.length,1);
    assert.equal(pending[0].leg,'L1');
    assert.equal(pending[0].pending[0].code,'load-missing');
    assert.match(pending[0].pending[0].detail,/箱单补发中/);
    source.setPhase('normal');
    assert.equal((await fetch(intake.origin+'/collect',{method:'POST'})).status,200);
    const resolved=await(await fetch(intake.origin+'/pending')).json();
    assert.deepEqual(resolved[0].pending,[]);
  }finally{await intake.close();}
}));
