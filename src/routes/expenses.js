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
  if (!periodId || !paidBy || !concept || !date) {
    return res.status(400).json({ error: 'periodId, paidBy, concept y date son requeridos', message: 'periodId, paidBy, concept y date son requeridos' });
  }

  // Validate active period and date range
  const { data: period, error: periodError } = await supabase
    .from('periods')
    .select('*')
    .eq('id', periodId)
    .single();

  if (periodError || !period) {
    return res.status(400).json({
      error: 'No se encontró el período especificado',
      message: 'No se encontró el período especificado',
    });
  }

  if (period.is_closed) {
    return res.status(400).json({
      error: 'El período se encuentra cerrado',
      message: 'El período se encuentra cerrado',
    });
  }

  // Validate minimum roommates querying the database
  const houseId = req.body.houseId || req.body.house_id || period.house_id;
  const { count: roommateCount, error: countError } = await supabase
    .from('roommates')
    .select('*', { count: 'exact', head: true })
    .eq('house_id', houseId);

  if (countError) {
    return res.status(400).json({
      error: countError.message,
      message: countError.message,
    });
  }

  if (roommateCount < 2) {
    return res.status(400).json({
      error: 'Se necesitan al menos 2 integrantes para registrar gastos',
      message: 'Se necesitan al menos 2 integrantes para registrar gastos',
    });
  }

  const dateParts = String(date).split('T')[0].split('-');
  const expenseYear = parseInt(dateParts[0], 10);
  const expenseMonth = parseInt(dateParts[1], 10);

  if (isNaN(expenseYear) || isNaN(expenseMonth)) {
    return res.status(400).json({
      error: 'La fecha del gasto no es válida',
      message: 'La fecha del gasto no es válida',
    });
  }

  if (expenseYear < period.year || (expenseYear === period.year && expenseMonth < period.month)) {
    return res.status(400).json({
      error: 'La fecha del gasto no puede ser anterior al inicio del período abierto',
      message: 'La fecha del gasto no puede ser anterior al inicio del período abierto',
    });
  }

  if (expenseYear !== period.year || expenseMonth !== period.month) {
    return res.status(400).json({
      error: 'La fecha del gasto debe pertenecer al período abierto',
      message: 'La fecha del gasto debe pertenecer al período abierto',
    });
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

  // Determine participants (if empty or not provided, default to all roommates in the house)
  let activeParticipants = participants;
  if (!activeParticipants || !Array.isArray(activeParticipants) || activeParticipants.length === 0) {
    const { data: allHouseRoommates } = await supabase
      .from('roommates')
      .select('id')
      .eq('house_id', houseId);
    activeParticipants = (allHouseRoommates || []).map((r) => r.id);
  }

  // Fetch participants ordered by created_at
  const { data: roommates, error: roommatesError } = await supabase
    .from('roommates')
    .select('id, created_at')
    .in('id', activeParticipants)
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
