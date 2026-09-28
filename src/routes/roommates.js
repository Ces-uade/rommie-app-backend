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
  const { houseId, name } = req.body;

  if (!houseId) {
    return res.status(400).json({ error: 'houseId is required' });
  }

  if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 50) {
    return res.status(400).json({ error: 'El nombre debe tener entre 1 y 50 caracteres' });
  }

  const { data, error } = await supabase
    .from('roommates')
    .insert({ house_id: houseId, name: name.trim() })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Ya existe un conviviente con ese nombre o alias' });
    }
    return res.status(400).json({ error: error.message });
  }

  return res.status(201).json(data);
});

module.exports = router;
