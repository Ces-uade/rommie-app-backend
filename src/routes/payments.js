const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

router.post('/', async (req, res) => {
  const { periodId, paidBy, paidTo, amount } = req.body;

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'amount debe ser un número mayor a 0' });
  }

  if (!periodId || !paidBy || !paidTo) {
    return res.status(400).json({ error: 'periodId, paidBy y paidTo son requeridos' });
  }

  const { data, error } = await supabase
    .from('payments')
    .insert([{
      period_id: periodId,
      paid_by: paidBy,
      paid_to: paidTo,
      amount: parsedAmount
    }])
    .select()
    .single();

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(201).json(data);
});

router.get('/', async (req, res) => {
  const { periodId } = req.query;

  if (!periodId) {
    return res.status(400).json({ error: 'periodId is required' });
  }

  const { data, error } = await supabase
    .from('payments')
    .select('*, paid_by:roommates!paid_by(id, name), paid_to:roommates!paid_to(id, name)')
    .eq('period_id', periodId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json(data);
});

module.exports = router;
