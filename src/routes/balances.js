const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

router.get('/', async (req, res) => {
  const { periodId, houseId } = req.query;

  if (!periodId || !houseId) {
    return res.status(400).json({ error: 'periodId and houseId are required' });
  }

  // 1. Get all roommates
  const { data: roommates, error: rmError } = await supabase
    .from('roommates')
    .select('id, name')
    .eq('house_id', houseId);

  if (rmError) {
    return res.status(400).json({ error: rmError.message });
  }

  // 2. Get expenses with splits
  const { data: expenses, error: expError } = await supabase
    .from('expenses')
    .select('*, expense_splits(*)')
    .eq('period_id', periodId);

  if (expError) {
    return res.status(400).json({ error: expError.message });
  }

  // 3. Get payments
  const { data: payments, error: payError } = await supabase
    .from('payments')
    .select('*')
    .eq('period_id', periodId);

  const paymentList = payError ? [] : (payments || []);

  // 4. Calculate balances
  const balanceMap = {};
  roommates.forEach(rm => { balanceMap[rm.id] = 0; });

  expenses.forEach(exp => {
    // paid_by gets +amount
    if (balanceMap[exp.paid_by] !== undefined) {
      balanceMap[exp.paid_by] += parseFloat(exp.amount);
    }
    // each split participant gets -split amount
    exp.expense_splits.forEach(split => {
      if (balanceMap[split.roommate_id] !== undefined) {
        balanceMap[split.roommate_id] -= parseFloat(split.amount);
      }
    });
  });

  paymentList.forEach(pay => {
    const fromId = pay.paid_by || pay.from_roommate_id;
    const toId = pay.paid_to || pay.to_roommate_id;
    // sender sent money -> +amount
    if (balanceMap[fromId] !== undefined) {
      balanceMap[fromId] += parseFloat(pay.amount);
    }
    // receiver received money -> -amount
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

  return res.status(200).json({ balances, debts });
});

module.exports = router;
