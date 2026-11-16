const RECORD_TYPES = new Set(['bill', 'cargo', 'notice', 'load', 'pending']);

const idFor = {
  bill: (carrier, leg, billId) => `bill:${carrier}:${leg}:${billId}`,
  cargo: (carrier, leg, cargoId) => `cargo:${carrier}:${leg}:${cargoId}`,
  notice: (carrier, leg, noticeId, noticeRevision) => `notice:${carrier}:${leg}:${noticeId}:${noticeRevision}`,
  load: (carrier, leg, cargoId) => `load:${carrier}:${leg}:${cargoId}`,
  pending: (carrier, leg, key) => `pending:${carrier}:${leg}:${key}`,
};

// 内容比较不计入归档摘要与序号
const contentOf = record => {
  const {revision, seq, ...content} = record;
  return JSON.stringify(content);
};
const sameContent = (left, right) => contentOf(left) === contentOf(right);

function legScope(carrier, leg) {
  return {
    carrier, leg,
    bills: new Map(),      // billId → 最新单据状态
    cargos: new Map(),     // cargoId → 最新货物归属
    loads: new Map(),      // cargoId → 最新装载证据
    notices: new Map(),    // noticeId:revision → 声明原文
    superseded: new Set(), // 已被后续声明替换的 noticeId
    pendings: new Map(),   // key → 最新未决事项
    priorById: new Map(),
    seqById: new Map(),
    discrepancies: [],
  };
}

// 从归档记录还原各运输段的最新关系状态
export function viewState(records = []) {
  const legs = new Map();
  for (const stored of records) {
    if (!stored || !RECORD_TYPES.has(stored.type)) continue;
    const {revision, ...record} = stored;
    const key = `${record.carrier}:${record.leg}`;
    if (!legs.has(key)) legs.set(key, legScope(record.carrier, record.leg));
    const state = legs.get(key);
    const seq = record.seq ?? 0;
    if (record.type === 'bill' || record.type === 'cargo' || record.type === 'pending') {
      state.seqById.set(record.id, Math.max(state.seqById.get(record.id) ?? 0, seq));
    }
    if (record.type === 'bill') {
      const existing = state.bills.get(record.billId);
      if (!existing || seq >= (existing.seq ?? 0)) state.bills.set(record.billId, record);
    } else if (record.type === 'cargo') {
      const existing = state.cargos.get(record.cargoId);
      if (!existing || seq >= (existing.seq ?? 0)) state.cargos.set(record.cargoId, record);
    } else if (record.type === 'load') {
      const existing = state.loads.get(record.cargoId);
      if (!existing || record.version >= existing.version) state.loads.set(record.cargoId, record);
    } else if (record.type === 'notice') {
      state.notices.set(`${record.noticeId}:${record.noticeRevision}`, record);
      if (record.replaces) state.superseded.add(record.replaces);
    } else if (record.type === 'pending') {
      const existing = state.pendings.get(record.key);
      if (!existing || seq >= (existing.seq ?? 0)) state.pendings.set(record.key, record);
    }
  }
  for (const state of legs.values()) {
    for (const record of [...state.bills.values(), ...state.cargos.values(), ...state.loads.values(), ...state.pendings.values()]) {
      state.priorById.set(record.id, record);
    }
  }
  return legs;
}

function emit(state, emissions, record, sequenced = true) {
  const prior = state.priorById.get(record.id);
  if (prior && sameContent(prior, record)) return false;
  if (sequenced) {
    const seq = (state.seqById.get(record.id) ?? 0) + 1;
    state.seqById.set(record.id, seq);
    record.seq = seq;
  }
  state.priorById.set(record.id, record);
  emissions.push(record);
  return true;
}

function validateNotice(notice) {
  if (!notice || typeof notice.noticeId !== 'string' || !notice.noticeId
    || typeof notice.leg !== 'string' || !notice.leg
    || !Number.isInteger(notice.revision)
    || !Array.isArray(notice.bills) || !Array.isArray(notice.moves)) throw new Error('关系声明格式无效');
  for (const bill of notice.bills) {
    if (!bill || typeof bill.billId !== 'string' || !bill.billId) throw new Error('关系声明格式无效');
  }
  for (const move of notice.moves) {
    if (!move || typeof move.cargoId !== 'string' || !move.cargoId) throw new Error('关系声明格式无效');
  }
}

// 应用一组声明：单据只按显式字段更新，货物归属只随显式 moves 变化，票据撤销不删除货物
function applyNotice(state, notice, emissions) {
  const declaredBy = {noticeId: notice.noticeId, noticeRevision: notice.revision};
  for (const bill of notice.bills) {
    state.bills.set(bill.billId, {
      id: idFor.bill(state.carrier, state.leg, bill.billId),
      type: 'bill', carrier: state.carrier, leg: state.leg,
      billId: bill.billId, kind: bill.kind ?? null, status: bill.status ?? null,
      parent: bill.parent ?? null, declaredBy,
    });
  }
  for (const move of notice.moves) {
    const current = state.cargos.get(move.cargoId);
    const from = move.from ?? null;
    if (current && current.billId !== from) {
      state.discrepancies.push({
        key: `discrepancy:${move.cargoId}`,
        reason: '移动声明与现有归属不符',
        refs: [{cargoId: move.cargoId}],
        note: `声明自 ${from ?? '无'} 迁出，现有归属为 ${current.billId ?? '无'}`,
      });
    }
    state.cargos.set(move.cargoId, {
      id: idFor.cargo(state.carrier, state.leg, move.cargoId),
      type: 'cargo', carrier: state.carrier, leg: state.leg,
      cargoId: move.cargoId, billId: move.to ?? null, declaredBy,
    });
  }
  const record = {
    id: idFor.notice(state.carrier, state.leg, notice.noticeId, notice.revision),
    type: 'notice', carrier: state.carrier, leg: state.leg,
    noticeId: notice.noticeId, noticeRevision: notice.revision,
    replaces: notice.replaces ?? null, bills: notice.bills, moves: notice.moves,
  };
  state.notices.set(`${notice.noticeId}:${notice.revision}`, record);
  if (notice.replaces) state.superseded.add(notice.replaces);
  emit(state, emissions, record, false);
}

// 装载证据独立于单据关系获取；缺失或失败只登记未决，不阻塞其余资料
async function collectLoad(client, state, cargoId, wanted, emissions) {
  let load;
  try {
    load = await client(`/loads/${encodeURIComponent(cargoId)}`);
  } catch (error) {
    wanted.set(`load:${cargoId}`, {
      reason: error.status === 404 ? '箱单缺失' : '箱单获取失败',
      refs: [{cargoId}],
      note: error.message,
    });
    return;
  }
  if (!load || load.cargoId !== cargoId || load.leg !== state.leg || !Number.isInteger(load.version)) {
    wanted.set(`load:${cargoId}`, {reason: '箱单内容与声明不符', refs: [{cargoId}], note: `装载证据与 ${state.leg}:${cargoId} 不一致`});
    return;
  }
  const record = {
    id: idFor.load(state.carrier, state.leg, cargoId),
    type: 'load', carrier: state.carrier, leg: state.leg, cargoId,
    container: load.container ?? null, packages: load.packages ?? null, version: load.version,
  };
  state.loads.set(cargoId, record);
  emit(state, emissions, record, false);
}

// 一致性核对：缺关联票据、货物落在已撤销票据上、声明与现状不符，都登记未决交资料岗
function settle(state, wanted, emissions) {
  const missingBill = (billId, ref) => {
    const key = `bill:${billId}`;
    const entry = wanted.get(key) ?? {reason: '关联票据缺失', refs: []};
    entry.refs.push(ref);
    wanted.set(key, entry);
  };
  for (const bill of state.bills.values()) {
    if (bill.parent && !state.bills.has(bill.parent)) missingBill(bill.parent, {billId: bill.billId, as: '上级票据'});
  }
  for (const cargo of state.cargos.values()) {
    if (!cargo.billId) continue;
    const bill = state.bills.get(cargo.billId);
    if (!bill) missingBill(cargo.billId, {cargoId: cargo.cargoId, as: '装载去向'});
    else if (bill.status === 'cancelled') {
      wanted.set(`stranded:${cargo.cargoId}`, {reason: '货物所属票据已撤销', refs: [{cargoId: cargo.cargoId, billId: cargo.billId}]});
    }
  }
  for (const item of state.discrepancies) wanted.set(item.key, item);
  for (const [key, wish] of wanted) {
    const record = {
      id: idFor.pending(state.carrier, state.leg, key),
      type: 'pending', carrier: state.carrier, leg: state.leg,
      key, reason: wish.reason, status: 'open', refs: wish.refs,
    };
    if (wish.note) record.note = wish.note;
    emit(state, emissions, record);
    state.pendings.set(key, state.priorById.get(record.id));
  }
  for (const [key, existing] of state.pendings) {
    if (existing.status !== 'open' || wanted.has(key) || key.startsWith('discrepancy:')) continue;
    const record = {...existing, status: 'resolved'};
    emit(state, emissions, record);
    state.pendings.set(key, state.priorById.get(record.id));
  }
}

// 一次接收：单票、关系声明、装载证据；prior 为归档中已有记录，用于中断后续收
export async function collect(client, prior = []) {
  const document = await client('/bill');
  const carrier = document.carrier;
  const legs = viewState(prior);
  const scope = leg => {
    const key = `${carrier}:${leg}`;
    if (!legs.has(key)) legs.set(key, legScope(carrier, leg));
    return legs.get(key);
  };
  const response = await client('/notices');
  if (!response || !Array.isArray(response.items)) throw new Error('关系声明格式无效');
  for (const notice of response.items) validateNotice(notice);
  const fresh = response.items
    .filter(notice => {
      const state = scope(notice.leg);
      return !state.superseded.has(notice.noticeId) && !state.notices.has(`${notice.noticeId}:${notice.revision}`);
    })
    .sort((left, right) => left.revision - right.revision);
  const emissions = [];
  for (const notice of fresh) applyNotice(scope(notice.leg), notice, emissions);
  for (const state of legs.values()) {
    for (const record of [...state.bills.values(), ...state.cargos.values()]) emit(state, emissions, record);
  }
  for (const state of legs.values()) {
    const wanted = new Map();
    for (const cargoId of state.cargos.keys()) await collectLoad(client, state, cargoId, wanted, emissions);
    settle(state, wanted, emissions);
  }
  return [{id: `${document.carrier}:${document.leg}:${document.billId}`, ...document}, ...emissions];
}

// 当前自洽关系：每个运输段内每票、每货、每箱单各取最新版本
export function currentRelations(records = []) {
  return [...viewState(records).values()].map(state => ({
    carrier: state.carrier,
    leg: state.leg,
    bills: [...state.bills.values()].map(({billId, kind, status, parent, declaredBy}) => ({billId, kind, status, parent, declaredBy})),
    cargo: [...state.cargos.values()].map(({cargoId, billId, declaredBy}) => ({cargoId, billId, declaredBy})),
    loads: [...state.loads.values()].map(({cargoId, container, packages, version}) => ({cargoId, container, packages, version})),
  }));
}

// 待资料岗核对的未决事项
export function openPendings(records = []) {
  return [...viewState(records).values()].flatMap(state =>
    [...state.pendings.values()]
      .filter(record => record.status === 'open')
      .map(record => {
        const item = {carrier: state.carrier, leg: state.leg, key: record.key, reason: record.reason, refs: record.refs};
        if (record.note) item.note = record.note;
        return item;
      }));
}
