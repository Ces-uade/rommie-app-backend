const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

router.post('/', async (req, res) => {
  const { periodId, paidBy, concept, amount, date, participants } = req.body;

  // Validations
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'amount debe ser un número mayor a 0' });
  }
  // Max 2 decimals
  if (Math.round(parsedAmount * 100) !== parsedAmount * 100) {
    return res.status(400).json({ error: 'amount no puede tener más de 2 decimales' });
  }
  if (!participants || !Array.isArray(participants) || participants.length < 1) {
    return res.status(400).json({ error: 'participants debe tener al menos 1 elemento' });
  }
  if (!periodId || !paidBy || !concept || !date) {
    return res.status(400).json({ error: 'periodId, paidBy, concept y date son requeridos' });
  }

  // Insert expense
  const { data: expense, error: expenseError } = await supabase
    .from('expenses')
    .insert({ period_id: periodId, paid_by: paidBy, concept, amount: parsedAmount, date })
    .select()
    .single();

  if (expenseError) {
    return res.status(400).json({ error: expenseError.message });
  }

  // Fetch participants ordered by created_at
  const { data: roommates, error: roommatesError } = await supabase
    .from('roommates')
    .select('id, created_at')
    .in('id', participants)
    .order('created_at', { ascending: true });

  if (roommatesError) {
    return res.status(400).json({ error: roommatesError.message });
  }

  // Penny-accurate split
  const totalCents = Math.round(parsedAmount * 100);
  const n = roommates.length;
  const basePerParticipantCents = Math.floor(totalCents / n);
  const remainder = totalCents - basePerParticipantCents * n; // leftover pennies

  const splits = roommates.map((rm, index) => {
    const extraCent = index < remainder ? 1 : 0;
    const splitAmount = parseFloat(((basePerParticipantCents + extraCent) / 100).toFixed(2));
    return { expense_id: expense.id, roommate_id: rm.id, amount: splitAmount };
  });

  const { data: insertedSplits, error: splitsError } = await supabase
    .from('expense_splits')
    .insert(splits)
    .select();

  if (splitsError) {
    return res.status(400).json({ error: splitsError.message });
  }

  return res.status(201).json({ expense, splits: insertedSplits });
});

router.get('/', async (req, res) => {
  const { periodId } = req.query;

  if (!periodId) {
    return res.status(400).json({ error: 'periodId is required' });
  }

  const { data, error } = await supabase
    .from('expenses')
    .select('*, roommates(name), expense_splits(*, roommates(name))')
    .eq('period_id', periodId)
    .order('date', { ascending: false });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json(data);
});

module.exports = router;
