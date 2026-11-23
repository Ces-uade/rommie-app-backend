const supabase = require('../config/supabase');

async function calculatePeriodBalances(houseId, periodId) {
  // 1. Get period info (to check closing_debts if any)
  const { data: periodData } = await supabase
    .from('periods')
    .select('id, closing_debts')
    .eq('id', periodId)
    .maybeSingle();

  // 2. Get all roommates of the house
  const { data: allRoommates, error: rmError } = await supabase
    .from('roommates')
    .select('id, name, is_active')
    .eq('house_id', houseId);

  if (rmError) {
    throw new Error(rmError.message);
  }

  // 3. Get expenses with splits
  const { data: expenses, error: expError } = await supabase
    .from('expenses')
    .select('*, expense_splits(*)')
    .eq('period_id', periodId);

  if (expError) {
    throw new Error(expError.message);
  }

  // 4. Get payments
  const { data: payments, error: payError } = await supabase
    .from('payments')
    .select('*')
    .eq('period_id', periodId);

  const paymentList = payError ? [] : (payments || []);
  const expenseList = expenses || [];

  // Identificar participantes con movimientos en este período
  const activeMovementIds = new Set();
  expenseList.forEach((exp) => {
    if (exp.paid_by) activeMovementIds.add(exp.paid_by);
    (exp.expense_splits || []).forEach((split) => {
      if (split.roommate_id) activeMovementIds.add(split.roommate_id);
    });
  });

  paymentList.forEach((pay) => {
    const fromId = pay.paid_by || pay.from_roommate_id;
    const toId = pay.paid_to || pay.to_roommate_id;
    if (fromId) activeMovementIds.add(fromId);
    if (toId) activeMovementIds.add(toId);
  });

  if (Array.isArray(periodData?.closing_debts)) {
    periodData.closing_debts.forEach((d) => {
      if (d.deudor_id) activeMovementIds.add(d.deudor_id);
      if (d.acreedor_id) activeMovementIds.add(d.acreedor_id);
      if (d.from?.id) activeMovementIds.add(d.from.id);
      if (d.to?.id) activeMovementIds.add(d.to.id);
    });
  }

  // Incluir todos los is_active !== false, más inactivos con movimientos en el período
  const roommates = (allRoommates || []).filter((rm) => {
    const isActive = rm.is_active !== false;
    return isActive || activeMovementIds.has(rm.id);
  });

  // 5. Calculate balances
  const balanceMap = {};
  roommates.forEach(rm => { balanceMap[rm.id] = 0; });

  expenses.forEach(exp => {
    if (balanceMap[exp.paid_by] !== undefined) {
      balanceMap[exp.paid_by] += parseFloat(exp.amount);
    }
    exp.expense_splits.forEach(split => {
      if (balanceMap[split.roommate_id] !== undefined) {
        balanceMap[split.roommate_id] -= parseFloat(split.amount);
      }
    });
  });

  paymentList.forEach(pay => {
    const fromId = pay.paid_by || pay.from_roommate_id;
    const toId = pay.paid_to || pay.to_roommate_id;
    if (balanceMap[fromId] !== undefined) {
      balanceMap[fromId] += parseFloat(pay.amount);
    }
    if (balanceMap[toId] !== undefined) {
      balanceMap[toId] -= parseFloat(pay.amount);
    }
  });

  const balances = roommates.map(rm => ({
    id: rm.id,
    name: rm.name,
    balance: parseFloat(balanceMap[rm.id].toFixed(2)),
  }));

  // 5. Calculate pairwise debts
  const debtMap = {};
  roommates.forEach(a => {
    debtMap[a.id] = {};
    roommates.forEach(b => {
      debtMap[a.id][b.id] = 0;
    });
  });

  expenses.forEach(exp => {
    const payerId = exp.paid_by;
    exp.expense_splits.forEach(split => {
      if (split.roommate_id !== payerId) {
        debtMap[split.roommate_id][payerId] += parseFloat(split.amount);
      }
    });
  });

  paymentList.forEach(pay => {
    const fromId = pay.paid_by || pay.from_roommate_id;
    const toId = pay.paid_to || pay.to_roommate_id;
    if (debtMap[fromId] && debtMap[fromId][toId] !== undefined) {
      debtMap[fromId][toId] -= parseFloat(pay.amount);
    }
  });

  // 6. Reciprocal compensation
  const debts = [];
  const processed = new Set();
  const rmIds = roommates.map(r => r.id);
  const nameMap = {};
  roommates.forEach(r => { nameMap[r.id] = r.name; });

  for (const a of rmIds) {
    for (const b of rmIds) {
      if (a === b) continue;
      const pairKey = [a, b].sort().join('|');
      if (processed.has(pairKey)) continue;
      processed.add(pairKey);

      const net = parseFloat((debtMap[a][b] - debtMap[b][a]).toFixed(2));
      if (net > 0) {
        debts.push({
          deudor_id: a,
          acreedor_id: b,
          deudor: nameMap[a],
          acreedor: nameMap[b],
          monto: net,
          from: { id: a, name: nameMap[a] },
          to: { id: b, name: nameMap[b] },
          amount: net,
        });
      } else if (net < 0) {
        debts.push({
          deudor_id: b,
          acreedor_id: a,
          deudor: nameMap[b],
          acreedor: nameMap[a],
          monto: Math.abs(net),
          from: { id: b, name: nameMap[b] },
          to: { id: a, name: nameMap[a] },
          amount: Math.abs(net),
        });
      }
    }
  }

  return { balances, debts };
}

module.exports = { calculatePeriodBalances };
