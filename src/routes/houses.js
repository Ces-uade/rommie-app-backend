const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

const INVALID_CODE_MSG = 'El código o enlace de invitación es inválido o ha expirado';
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_SECRET = process.env.INVITE_SECRET || process.env.SUPABASE_SERVICE_KEY || 'roomie-invite-secret';
const HOUSE_SELECT = '*, periods(*), roommates(*)';

const sign = (payload) =>
  crypto.createHmac('sha256', INVITE_SECRET).update(payload).digest('base64url');

const createInviteCode = (houseId) => {
  const expiresAt = Date.now() + INVITE_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ h: houseId, e: expiresAt })).toString('base64url');
  return { code: `${payload}.${sign(payload)}`, expiresAt };
};

const verifyInviteCode = (code) => {
  if (typeof code !== 'string') return null;
  const parts = code.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, signature] = parts;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { h, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!h || typeof e !== 'number' || e < Date.now()) return null;
    return { houseId: h };
  } catch {
    return null;
  }
};

const getJoinedHouseIds = async (userId) => {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data?.user) return { user: null, ids: [] };
    const ids = data.user.user_metadata?.joined_houses;
    return { user: data.user, ids: Array.isArray(ids) ? ids : [] };
  } catch {
    return { user: null, ids: [] };
  }
};

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
    return res.status(400).json({ error: 'userId is required', message: 'userId is required' });
  }

  const trimmedName = name.trim();

  // Verificar si ya existe una casa con ese mismo nombre para ese usuario (case-insensitive)
  const { data: existingHouses, error: searchError } = await supabase
    .from('houses')
    .select('*, periods(*)')
    .eq('owner_id', userId)
    .ilike('name', trimmedName)
    .limit(1);

  if (searchError) {
    return res.status(400).json({ error: searchError.message, message: searchError.message });
  }

  if (existingHouses && existingHouses.length > 0) {
    return res.status(400).json({
      error: 'Ya existe una casa con ese nombre',
      message: 'Ya existe una casa con ese nombre',
      house: existingHouses[0],
    });
  }

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .insert({ name: trimmedName, owner_id: userId })
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
    return res.status(400).json({ error: 'userId is required', message: 'userId is required' });
  }

  const { data: owned, error } = await supabase
    .from('houses')
    .select(HOUSE_SELECT)
    .eq('owner_id', userId);

  if (error) {
    return res.status(400).json({ error: error.message, message: error.message });
  }

  const houses = [...(owned || [])];
  const knownIds = new Set(houses.map((h) => h.id));

  const { ids } = await getJoinedHouseIds(userId);
  const missingIds = ids.filter((id) => !knownIds.has(id));

  if (missingIds.length > 0) {
    const { data: joined, error: joinedError } = await supabase
      .from('houses')
      .select(HOUSE_SELECT)
      .in('id', missingIds);

    if (joinedError) {
      return res.status(400).json({ error: joinedError.message, message: joinedError.message });
    }

    (joined || []).forEach((h) => {
      if (!knownIds.has(h.id)) {
        knownIds.add(h.id);
        houses.push(h);
      }
    });
  }

  return res.status(200).json(houses);
});

const handleInvite = async (req, res) => {
  const { id } = req.params;

  const { data: house, error } = await supabase
    .from('houses')
    .select('id')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return res.status(400).json({ error: error.message, message: error.message });
  }

  if (!house) {
    return res.status(400).json({ error: 'La casa no existe', message: 'La casa no existe' });
  }

  const { code, expiresAt } = createInviteCode(house.id);
  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  return res.status(200).json({
    code,
    link: `${baseUrl}/join?code=${encodeURIComponent(code)}`,
    expiresAt: new Date(expiresAt).toISOString(),
  });
};

router.get('/:id/invite', handleInvite);
router.post('/:id/invite', handleInvite);

router.post('/join', async (req, res) => {
  const { code, userId, userName, userEmail } = req.body;

  const parsed = verifyInviteCode(code);
  if (!parsed) {
    return res.status(400).json({ error: INVALID_CODE_MSG, message: INVALID_CODE_MSG });
  }

  if (!userId) {
    return res.status(400).json({ error: 'userId is required', message: 'userId is required' });
  }

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id')
    .eq('id', parsed.houseId)
    .maybeSingle();

  if (houseError || !house) {
    return res.status(400).json({ error: INVALID_CODE_MSG, message: INVALID_CODE_MSG });
  }

  const { user, ids } = await getJoinedHouseIds(userId);
  if (!user) {
    return res.status(400).json({ error: 'Usuario no encontrado', message: 'Usuario no encontrado' });
  }

  // a) Persistir vínculo userId <-> houseId en user_metadata.joined_houses
  if (!ids.includes(house.id)) {
    const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
      user_metadata: { ...(user.user_metadata || {}), joined_houses: [...ids, house.id] },
    });

    if (updateError) {
      return res.status(400).json({ error: updateError.message, message: updateError.message });
    }
  }

  // b) Crear conviviente con el nombre de cuenta si no existe (case-insensitive)
  const emailLocal = String(userEmail || user.email || '').split('@')[0];
  const accountName = (
    (typeof userName === 'string' && userName.trim()) ||
    (user.user_metadata?.name && String(user.user_metadata.name).trim()) ||
    emailLocal
  ).slice(0, 50);

  if (accountName) {
    const { data: existing, error: rmError } = await supabase
      .from('roommates')
      .select('name')
      .eq('house_id', house.id);

    if (rmError) {
      return res.status(400).json({ error: rmError.message, message: rmError.message });
    }

    const normalized = accountName.toLowerCase();
    const exists = (existing || []).some((r) => r.name && r.name.trim().toLowerCase() === normalized);

    if (!exists) {
      const { error: insertError } = await supabase
        .from('roommates')
        .insert({ house_id: house.id, name: accountName })
        .select()
        .single();

      if (insertError && insertError.code !== '23505') {
        return res.status(400).json({ error: insertError.message, message: insertError.message });
      }
    }
  }

  // c) Devolver la casa completa
  const { data: fullHouse, error: fullError } = await supabase
    .from('houses')
    .select(HOUSE_SELECT)
    .eq('id', house.id)
    .single();

  if (fullError) {
    return res.status(400).json({ error: fullError.message, message: fullError.message });
  }

  return res.status(200).json(fullHouse);
});

module.exports = router;
