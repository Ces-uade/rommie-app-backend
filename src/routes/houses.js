const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

router.post('/', async (req, res) => {
  const { name, month, year, userId } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 60) {
    return res.status(400).json({ error: 'Name must be between 1 and 60 non-empty characters' });
  }

  const parsedMonth = parseInt(month, 10);
  if (isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    return res.status(400).json({ error: 'Month must be an integer between 1 and 12' });
  }

  const parsedYear = parseInt(year, 10);
  if (isNaN(parsedYear)) {
    return res.status(400).json({ error: 'Year must be a valid number' });
  }

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .insert({ name: name.trim(), owner_id: userId })
    .select()
    .single();

  if (houseError) {
    return res.status(400).json({ error: houseError.message });
  }

  const { data: period, error: periodError } = await supabase
    .from('periods')
    .insert({ house_id: house.id, month: parsedMonth, year: parsedYear, is_closed: false })
    .select()
    .single();

  if (periodError) {
    return res.status(400).json({ error: periodError.message });
  }

  return res.status(201).json({ house, period });
});

router.get('/mine', async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const { data, error } = await supabase
    .from('houses')
    .select('*, periods(*)')
    .eq('owner_id', userId)
    .eq('periods.is_closed', false)
    .maybeSingle();

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json(data);
});

module.exports = router;
