import {digest} from './archive.mjs';

const byText=(left,right)=>left<right?-1:left>right?1:0;

// 每次抓取对应一条原文凭据，声明与箱单的来源据此回指归档
async function fetchWithSource(client,path){
  const before=client.exchanges.length;
  try{
    const value=await client(path);
    const exchange=client.exchanges[client.exchanges.length-1];
    return {value,source:{url:exchange.url,hash:digest(exchange.bytes)}};
  }catch(error){
    const exchange=client.exchanges.length>before?client.exchanges[client.exchanges.length-1]:undefined;
    if(exchange){
      let message;
      try{
        const parsed=JSON.parse(exchange.bytes.toString('utf8'));
        if(parsed&&typeof parsed.message==='string')message=parsed.message;
      }catch{}
      error.receipt={url:exchange.url,status:exchange.status,hash:digest(exchange.bytes),message};
    }
    throw error;
  }
}

function validateNotice(raw){
  if(!raw||typeof raw!=='object')throw new Error('分合声明格式无效');
  if(typeof raw.noticeId!=='string'||!raw.noticeId)throw new Error('分合声明缺少标识');
  if(typeof raw.leg!=='string'||!raw.leg)throw new Error('分合声明缺少运输段');
  if(!Number.isInteger(raw.revision)||raw.revision<1)throw new Error('分合声明修订号无效');
  if(raw.replaces!==null&&typeof raw.replaces!=='string')throw new Error('分合声明替换链无效');
  if(!Array.isArray(raw.bills)||!Array.isArray(raw.moves))throw new Error('分合声明缺少单据或迁移列表');
  for(const bill of raw.bills){
    if(!bill||typeof bill.billId!=='string'||!bill.billId)throw new Error('分合声明内单据缺少标识');
    if(typeof bill.kind!=='string'||typeof bill.status!=='string')throw new Error('分合声明内单据缺少种类或状态');
    if(bill.parent!==null&&typeof bill.parent!=='string')throw new Error('分合声明内单据归属无效');
  }
  for(const move of raw.moves){
    if(!move||typeof move.cargoId!=='string'||!move.cargoId)throw new Error('迁移声明缺少货物标识');
    if(move.from!==null&&typeof move.from!=='string')throw new Error('迁移声明起点无效');
    if(move.to!==null&&typeof move.to!=='string')throw new Error('迁移声明终点无效');
  }
  return {
    noticeId:raw.noticeId,leg:raw.leg,revision:raw.revision,replaces:raw.replaces,
    bills:raw.bills.map(bill=>({billId:bill.billId,kind:bill.kind,status:bill.status,parent:bill.parent})),
    moves:raw.moves.map(move=>({cargoId:move.cargoId,from:move.from,to:move.to}))
  };
}

function validateLoad(raw,leg,cargoId){
  if(!raw||typeof raw!=='object')throw new Error('箱单格式无效');
  if(raw.leg!==leg||raw.cargoId!==cargoId)throw new Error('箱单身份与运输段或货物不符');
  if(typeof raw.container!=='string'||!raw.container)throw new Error('箱单缺少箱号');
  if(!Number.isInteger(raw.packages)||raw.packages<0)throw new Error('箱单件数无效');
  if(!Number.isInteger(raw.version)||raw.version<1)throw new Error('箱单版本无效');
  return {leg:raw.leg,cargoId:raw.cargoId,container:raw.container,packages:raw.packages,version:raw.version};
}

// 同一运输段的分合声明按修订链整体折叠；货物归属只随显式迁移声明改变，不按号码或数量推断
export function foldNotices(declarations){
  const byId=new Map();
  for(const declaration of declarations){
    const existing=byId.get(declaration.noticeId);
    if(!existing||existing.revision<declaration.revision)byId.set(declaration.noticeId,declaration);
  }
  const ordered=[...byId.values()].sort((left,right)=>left.revision-right.revision);
  const bills=new Map();
  const placements=new Map();
  const pending=[];
  for(const notice of ordered){
    if(notice.replaces!==null&&!byId.has(notice.replaces)){
      pending.push({code:'notice-gap',noticeId:notice.noticeId,replaces:notice.replaces,detail:'替换链缺少前置声明'});
    }
    for(const bill of notice.bills){
      bills.set(bill.billId,{billId:bill.billId,kind:bill.kind,status:bill.status,parent:bill.parent,declaredBy:notice.noticeId});
    }
    for(const move of notice.moves){
      const current=placements.get(move.cargoId);
      const from=current?current.bill:null;
      if(move.from!==from){
        pending.push({code:'move-from-mismatch',cargoId:move.cargoId,noticeId:notice.noticeId,declared:move.from,actual:from,detail:'迁移起点与现有归属不一致'});
      }
      if(move.to===null){placements.delete(move.cargoId);continue;}
      placements.set(move.cargoId,{cargoId:move.cargoId,bill:move.to,movedBy:notice.noticeId});
    }
  }
  for(const placement of placements.values()){
    if(!bills.has(placement.bill)){
      pending.push({code:'bill-missing',cargoId:placement.cargoId,billId:placement.bill,noticeId:placement.movedBy,detail:'迁移终点缺少关联票据'});
      continue;
    }
    if(bills.get(placement.bill).status==='cancelled'){
      pending.push({code:'cargo-on-cancelled-bill',cargoId:placement.cargoId,billId:placement.bill,detail:'货物仍挂在已撤销单据，未见迁移声明'});
    }
  }
  return {
    notices:ordered.map(notice=>({noticeId:notice.noticeId,revision:notice.revision})),
    head:ordered.length?{noticeId:ordered[ordered.length-1].noticeId,revision:ordered[ordered.length-1].revision}:null,
    bills:[...bills.values()].sort((left,right)=>byText(left.billId,right.billId)),
    placements:[...placements.values()].sort((left,right)=>byText(left.cargoId,right.cargoId)),
    pending
  };
}

const relationContent=record=>({notices:record.notices,head:record.head,bills:record.bills,placements:record.placements,loads:record.loads,pending:record.pending});

export function latestRelations(records){
  const latest=new Map();
  for(const record of records){
    if(record.type!=='relation')continue;
    const key=record.carrier+':'+record.leg;
    const existing=latest.get(key);
    if(!existing||existing.sequence<record.sequence)latest.set(key,record);
  }
  return [...latest.values()];
}

export async function collectRelations(client,previousRecords,{carrier}){
  if(typeof carrier!=='string'||!carrier)throw new Error('缺少承运方标识');
  const {value,source}=await fetchWithSource(client,'/notices');
  const items=value&&value.items;
  if(!Array.isArray(items))throw new Error('分合声明列表格式无效');
  const fresh=items.map(validateNotice);
  const legs=[...new Set(fresh.map(notice=>notice.leg))].sort(byText);
  const records=[];
  for(const leg of legs){
    const declarations=fresh.filter(notice=>notice.leg===leg);
    for(const declaration of declarations){
      records.push({id:`notice:${carrier}:${leg}:${declaration.noticeId}`,type:'notice',carrier,leg,declaration,source});
    }
    const archived=previousRecords
      .filter(record=>record.type==='notice'&&record.carrier===carrier&&record.leg===leg)
      .map(record=>record.declaration);
    const folded=foldNotices([...archived,...declarations]);
    const archivedLoads=new Map();
    for(const record of previousRecords){
      if(record.type!=='load'||record.carrier!==carrier||record.leg!==leg)continue;
      const existing=archivedLoads.get(record.load.cargoId);
      if(!existing||existing.version<record.load.version)archivedLoads.set(record.load.cargoId,record.load);
    }
    const loads=[];
    const pending=[...folded.pending];
    const cargoIds=folded.placements.map(placement=>placement.cargoId).sort(byText);
    for(const cargoId of cargoIds){
      try{
        const fetched=await fetchWithSource(client,'/loads/'+encodeURIComponent(cargoId));
        const load=validateLoad(fetched.value,leg,cargoId);
        records.push({id:`load:${carrier}:${leg}:${cargoId}`,type:'load',carrier,leg,load,source:fetched.source});
        loads.push({cargoId,container:load.container,packages:load.packages,version:load.version});
      }catch(error){
        const entry={code:'load-missing',cargoId,detail:(error.receipt&&error.receipt.message)||error.message};
        if(error.receipt)entry.source={url:error.receipt.url,hash:error.receipt.hash};
        pending.push(entry);
        const fallback=archivedLoads.get(cargoId);
        if(fallback)loads.push({cargoId,container:fallback.container,packages:fallback.packages,version:fallback.version});
      }
    }
    loads.sort((left,right)=>byText(left.cargoId,right.cargoId));
    const snapshot={notices:folded.notices,head:folded.head,bills:folded.bills,placements:folded.placements,loads,pending};
    const previous=latestRelations(previousRecords).find(record=>record.carrier===carrier&&record.leg===leg);
    if(!previous||JSON.stringify(relationContent(previous))!==JSON.stringify(snapshot)){
      records.push({id:`relation:${carrier}:${leg}`,type:'relation',carrier,leg,sequence:previous?previous.sequence+1:1,...snapshot});
    }
  }
  return records;
}
