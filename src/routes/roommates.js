const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

router.get('/', async (req, res) => {
  const { houseId } = req.query;

  if (!houseId) {
    return res.status(400).json({ error: 'houseId is required' });
  }

  const { data, error } = await supabase
    .from('roommates')
    .select('*')
    .eq('house_id', houseId)
    .order('created_at', { ascending: true });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json(data);
});

router.post('/', async (req, res) => {
  const { houseId, house_id, name } = req.body;
  const targetHouseId = houseId || house_id;

  if (!targetHouseId) {
    return res.status(400).json({ error: 'houseId is required', message: 'houseId is required' });
  }

  if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 50) {
    return res.status(400).json({ error: 'El nombre debe tener entre 1 y 50 caracteres', message: 'El nombre debe tener entre 1 y 50 caracteres' });
  }

  const normalizedInputName = name.trim().toLowerCase();

  const { data: existingRoommates, error: fetchError } = await supabase
    .from('roommates')
    .select('name')
    .eq('house_id', targetHouseId);

  if (fetchError) {
    return res.status(400).json({ error: fetchError.message, message: fetchError.message });
  }

  const isDuplicate = existingRoommates?.some(
    (rm) => rm.name && rm.name.trim().toLowerCase() === normalizedInputName
  );

  if (isDuplicate) {
    return res.status(400).json({
      error: 'Ya existe un conviviente con ese nombre o alias',
      message: 'Ya existe un conviviente con ese nombre o alias',
    });
  }

  const { data, error } = await supabase
    .from('roommates')
    .insert({ house_id: targetHouseId, name: name.trim() })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(400).json({
        error: 'Ya existe un conviviente con ese nombre o alias',
        message: 'Ya existe un conviviente con ese nombre o alias',
      });
    }
    return res.status(400).json({ error: error.message, message: error.message });
  }

  return res.status(201).json(data);
});

module.exports = router;
