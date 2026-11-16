import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startSource} from '../provider/server.mjs';
import {createClient} from '../src/source.mjs';
import {collect,currentRelations,openPendings} from '../src/reader.mjs';
import {openArchive} from '../src/archive.mjs';
import {startIntake} from '../src/app.mjs';

async function environment(run){
 const directory=await mkdtemp(join(tmpdir(),'relations-test-'));const source=await startSource();
 try{await run({directory,source});}finally{await source.close();await rm(directory,{recursive:true,force:true});}
}
async function collectOnce(source,prior=[]){
 const client=createClient(source.origin);return {records:await collect(client,prior),exchanges:client.exchanges};
}
function fakeClient(routes){
 const client=async path=>{
  const route=routes[path];
  if(!route){const error=new Error('来源返回 404');error.status=404;throw error;}
  return typeof route==='function'?route():route;
 };
 client.exchanges=[];
 return client;
}

test('分票关系按运输段、单据修订与装载身份分别归档',()=>environment(async({source})=>{
 const {records}=await collectOnce(source);
 const bills=records.filter(record=>record.type==='bill');
 assert.deepEqual(bills.map(bill=>bill.billId).sort(),['B1','H1']);
 const h1=bills.find(bill=>bill.billId==='H1');
 assert.equal(h1.parent,'B1');assert.equal(h1.kind,'house');assert.equal(h1.leg,'L1');
 assert.deepEqual(h1.declaredBy,{noticeId:'n1',noticeRevision:1});
 const cargo=records.find(record=>record.type==='cargo');
 assert.equal(cargo.cargoId,'c1');assert.equal(cargo.billId,'H1');
 const notice=records.find(record=>record.type==='notice');
 assert.equal(notice.noticeId,'n1');assert.equal(notice.noticeRevision,1);assert.equal(notice.replaces,null);
 assert.ok(Array.isArray(notice.bills)&&Array.isArray(notice.moves));
 const load=records.find(record=>record.type==='load');
 assert.equal(load.container,'box1');assert.equal(load.packages,12);assert.equal(load.version,1);
 assert.ok(!('declaredBy' in load));
 assert.ok(records.some(record=>record.id==='C1:L1:B1'&&!record.type));
}));

test('合票修订迁移货物且旧分单撤销不删除货物',()=>environment(async({source})=>{
 const first=await collectOnce(source);
 source.setPhase('regroup');
 const second=await collectOnce(source,first.records);
 const all=[...first.records,...second.records];
 const relations=currentRelations(all);
 assert.equal(relations.length,1);
 const leg=relations[0];
 assert.equal(leg.bills.find(bill=>bill.billId==='H1').status,'cancelled');
 assert.equal(leg.bills.find(bill=>bill.billId==='B2').status,'active');
 assert.ok(leg.bills.some(bill=>bill.billId==='B1'&&bill.status==='active'));
 const cargo=leg.cargo.filter(item=>item.cargoId==='c1');
 assert.equal(cargo.length,1);
 assert.equal(cargo[0].billId,'B2');
 assert.deepEqual(cargo[0].declaredBy,{noticeId:'n2',noticeRevision:2});
 assert.ok(leg.loads.some(load=>load.cargoId==='c1'));
 assert.deepEqual(openPendings(all),[]);
}));

test('拆并声明保留来源与修订链且旧声明重放不改变关系',()=>environment(async({source})=>{
 const first=await collectOnce(source);
 source.setPhase('regroup');
 const second=await collectOnce(source,first.records);
 const notices=[...first.records,...second.records].filter(record=>record.type==='notice');
 assert.equal(notices.length,2);
 assert.equal(notices.find(notice=>notice.noticeId==='n1').replaces,null);
 const n2=notices.find(notice=>notice.noticeId==='n2');
 assert.equal(n2.replaces,'n1');assert.equal(n2.moves[0].to,'B2');
 source.setPhase('normal');
 const third=await collectOnce(source,[...first.records,...second.records]);
 assert.equal(third.records.filter(record=>record.type==='notice').length,0);
 const relations=currentRelations([...first.records,...second.records,...third.records]);
 assert.equal(relations[0].cargo.find(item=>item.cargoId==='c1').billId,'B2');
}));

test('缺少箱单时记录未决原因并继续接收，补发后了结',()=>environment(async({source})=>{
 source.setPhase('missing-load');
 const first=await collectOnce(source);
 const pendings=openPendings(first.records);
 assert.equal(pendings.length,1);
 assert.equal(pendings[0].reason,'箱单缺失');
 assert.deepEqual(pendings[0].refs,[{cargoId:'c1'}]);
 assert.ok(first.records.some(record=>record.type==='cargo'&&record.billId==='H1'));
 assert.ok(!first.records.some(record=>record.type==='load'));
 source.setPhase('normal');
 const second=await collectOnce(source,first.records);
 assert.ok(second.records.some(record=>record.type==='load'&&record.container==='box1'));
 assert.deepEqual(openPendings([...first.records,...second.records]),[]);
}));

test('箱号件数调整独立于单据关系发布',()=>environment(async({source})=>{
 const first=await collectOnce(source);
 source.setPhase('reload');
 const second=await collectOnce(source,first.records);
 const load=second.records.find(record=>record.type==='load');
 assert.equal(load.container,'box2');assert.equal(load.packages,10);assert.equal(load.version,2);
 assert.ok(!second.records.some(record=>record.type==='bill'||record.type==='cargo'||record.type==='notice'));
 const relations=currentRelations([...first.records,...second.records])[0];
 assert.equal(relations.cargo.find(item=>item.cargoId==='c1').billId,'H1');
 assert.equal(relations.loads.find(item=>item.cargoId==='c1').version,2);
}));

test('缺少关联票据时不虚构票据并交资料岗核对',async()=>{
 const client=fakeClient({
  '/bill':{carrier:'C1',leg:'L1',billId:'B1',kind:'master',packages:12},
  '/notices':{items:[{noticeId:'n9',leg:'L1',revision:1,replaces:null,
   bills:[{billId:'B1',kind:'master',status:'active',parent:null}],
   moves:[{cargoId:'c9',from:null,to:'B9'}]}]},
 });
 const records=await collect(client);
 const cargo=records.find(record=>record.type==='cargo');
 assert.equal(cargo.billId,'B9');
 assert.ok(!records.some(record=>record.type==='bill'&&record.billId==='B9'));
 const pendings=openPendings(records);
 assert.equal(pendings.find(pending=>pending.key==='bill:B9').reason,'关联票据缺失');
 assert.ok(pendings.some(pending=>pending.key==='load:c9'));
});

test('不以号码相近或件数相等推测关系',async()=>{
 const client=fakeClient({
  '/bill':{carrier:'C1',leg:'L1',billId:'B1',kind:'master',packages:12},
  '/notices':{items:[{noticeId:'n1',leg:'L1',revision:1,replaces:null,
   bills:[
    {billId:'B1',kind:'master',status:'active',parent:null},
    {billId:'B2',kind:'master',status:'active',parent:null},
    {billId:'H1',kind:'house',status:'active',parent:'B1'}],
   moves:[{cargoId:'c1',from:null,to:'H1'},{cargoId:'c2',from:null,to:'B2'}]}]},
  '/loads/c1':{leg:'L1',cargoId:'c1',container:'box1',packages:12,version:1},
  '/loads/c2':{leg:'L1',cargoId:'c2',container:'box2',packages:12,version:1},
 });
 const records=await collect(client);
 const relations=currentRelations(records)[0];
 assert.equal(relations.bills.find(bill=>bill.billId==='H1').parent,'B1');
 assert.equal(relations.bills.find(bill=>bill.billId==='B2').parent,null);
 assert.equal(relations.cargo.filter(item=>item.cargoId==='c1').length,1);
 assert.equal(relations.cargo.find(item=>item.cargoId==='c1').billId,'H1');
 assert.equal(relations.cargo.find(item=>item.cargoId==='c2').billId,'B2');
 assert.deepEqual(openPendings(records),[]);
});

test('移动声明与现有归属不符时保留未决原因',async()=>{
 const notices={
  first:{items:[{noticeId:'n1',leg:'L1',revision:1,replaces:null,
   bills:[{billId:'H1',kind:'house',status:'active',parent:null}],
   moves:[{cargoId:'c1',from:null,to:'H1'}]}]},
  second:{items:[{noticeId:'n2',leg:'L1',revision:2,replaces:'n1',
   bills:[{billId:'B2',kind:'master',status:'active',parent:null}],
   moves:[{cargoId:'c1',from:'B7',to:'B2'}]}]},
 };
 let current=notices.first;
 const client=fakeClient({
  '/bill':{carrier:'C1',leg:'L1',billId:'B1',kind:'master',packages:12},
  '/notices':()=>current,
  '/loads/c1':{leg:'L1',cargoId:'c1',container:'box1',packages:12,version:1},
 });
 const first=await collect(client);
 current=notices.second;
 const second=await collect(client,first);
 const all=[...first,...second];
 assert.equal(currentRelations(all)[0].cargo.find(item=>item.cargoId==='c1').billId,'B2');
 const pendings=openPendings(all);
 assert.ok(pendings.some(pending=>pending.reason==='移动声明与现有归属不符'&&pending.refs[0].cargoId==='c1'));
});

test('接收中断后从归档接着补收且不重复建版',()=>environment(async({directory,source})=>{
 const archive=await openArchive(directory);
 const first=createClient(source.origin);
 await archive.commit(await collect(first),first.exchanges);
 const size=archive.records().length;
 const replay=createClient(source.origin);
 await archive.commit(await collect(replay,archive.records()),replay.exchanges);
 assert.equal(archive.records().length,size);
 source.setPhase('regroup');
 const reopened=await openArchive(directory);
 const next=createClient(source.origin);
 await reopened.commit(await collect(next,reopened.records()),next.exchanges);
 assert.equal(reopened.records().length,size+4);
 const relations=currentRelations(reopened.records())[0];
 assert.ok(relations.bills.some(bill=>bill.billId==='B1'&&bill.status==='active'));
 assert.equal(relations.cargo.find(item=>item.cargoId==='c1').billId,'B2');
 const again=createClient(source.origin);
 await reopened.commit(await collect(again,reopened.records()),again.exchanges);
 assert.equal(reopened.records().length,size+4);
}));

test('对外关系版本自洽且未决事项可查询',()=>environment(async({directory,source})=>{
 const intake=await startIntake({origin:source.origin,directory});
 try{
  assert.equal((await fetch(intake.origin+'/collect',{method:'POST'})).status,200);
  let relations=await(await fetch(intake.origin+'/relations')).json();
  assert.equal(relations[0].cargo.filter(item=>item.cargoId==='c1').length,1);
  assert.equal(relations[0].cargo[0].billId,'H1');
  source.setPhase('regroup');
  assert.equal((await fetch(intake.origin+'/collect',{method:'POST'})).status,200);
  relations=await(await fetch(intake.origin+'/relations')).json();
  const cargo=relations[0].cargo.filter(item=>item.cargoId==='c1');
  assert.equal(cargo.length,1);
  assert.equal(cargo[0].billId,'B2');
  assert.ok(relations[0].bills.some(bill=>bill.billId==='B2'&&bill.status==='active'));
  assert.ok(relations[0].bills.some(bill=>bill.billId==='H1'&&bill.status==='cancelled'));
  source.setPhase('missing-load');
  assert.equal((await fetch(intake.origin+'/collect',{method:'POST'})).status,200);
  const pending=await(await fetch(intake.origin+'/pending')).json();
  assert.ok(pending.some(item=>item.reason==='箱单缺失'));
 }finally{await intake.close();}
}));
