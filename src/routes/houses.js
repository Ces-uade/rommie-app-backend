const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { calculatePeriodBalances } = require('../utils/calculateBalances');

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

  // Vincular user_id al crear el conviviente inicial del creador
  let creatorName = null;
  try {
    const { data: userData } = await supabase.auth.admin.getUserById(userId);
    if (userData?.user) {
      creatorName =
        (userData.user.user_metadata?.name && String(userData.user.user_metadata.name).trim()) ||
        String(userData.user.email || '').split('@')[0];
    }
  } catch {
    // ignore
  }

  if (creatorName) {
    await supabase.from('roommates').insert({
      house_id: house.id,
      name: creatorName.slice(0, 50),
      user_id: userId,
      is_active: true,
    });
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

  // Filtrar roommates para que incluyan solo is_active === true y marcar is_owner
  const ownerNamesCache = {};
  const formattedHouses = await Promise.all(
    houses.map(async (h) => {
      const allRms = Array.isArray(h.roommates) ? h.roommates : [];
      const activeRms = allRms.filter((r) => r.is_active !== false);

      let ownerName = null;
      if (h.owner_id) {
        if (ownerNamesCache[h.owner_id] !== undefined) {
          ownerName = ownerNamesCache[h.owner_id];
        } else {
          try {
            const { data: userData } = await supabase.auth.admin.getUserById(h.owner_id);
            if (userData?.user) {
              ownerName =
                (userData.user.user_metadata?.name && String(userData.user.user_metadata.name).trim().toLowerCase()) ||
                String(userData.user.email || '').split('@')[0].toLowerCase();
            }
          } catch {
            // ignore
          }
          ownerNamesCache[h.owner_id] = ownerName;
        }
      }

      const hasOwnerByUserId = activeRms.some((r) => r.user_id && r.user_id === h.owner_id);

      const enrichedRms = activeRms.map((r) => {
        let isOwner = false;
        if (r.user_id && h.owner_id && r.user_id === h.owner_id) {
          isOwner = true;
        } else if (!hasOwnerByUserId && ownerName && r.name && r.name.trim().toLowerCase() === ownerName) {
          isOwner = true;
        }
        return {
          ...r,
          is_owner: isOwner,
        };
      });

      return {
        ...h,
        roommates: enrichedRms,
      };
    })
  );

  return res.status(200).json(formattedHouses);
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
    const notFoundMsg = 'El código de invitación no es válido o la casa ya no existe';
    return res.status(404).json({ error: notFoundMsg, message: notFoundMsg });
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
      .select('id, name, user_id, is_active')
      .eq('house_id', house.id)
      .eq('is_active', true);

    if (rmError) {
      return res.status(400).json({ error: rmError.message, message: rmError.message });
    }

    const normalized = accountName.toLowerCase();
    const existingActive = (existing || []).find(
      (r) => (r.user_id && r.user_id === userId) || (r.name && r.name.trim().toLowerCase() === normalized)
    );

    if (!existingActive) {
      const { error: insertError } = await supabase
        .from('roommates')
        .insert({
          house_id: house.id,
          name: accountName,
          user_id: userId,
          is_active: true,
        })
        .select()
        .single();

      if (insertError && insertError.code !== '23505') {
        return res.status(400).json({ error: insertError.message, message: insertError.message });
      }
    } else if (!existingActive.user_id) {
      await supabase
        .from('roommates')
        .update({ user_id: userId })
        .eq('id', existingActive.id);
    }
  }

  // c) Devolver la casa completa con roommates activos
  const { data: fullHouse, error: fullError } = await supabase
    .from('houses')
    .select(HOUSE_SELECT)
    .eq('id', house.id)
    .single();

  if (fullError) {
    return res.status(400).json({ error: fullError.message, message: fullError.message });
  }

  const activeRms = (fullHouse?.roommates || []).filter((r) => r.is_active !== false);

  return res.status(200).json({
    ...fullHouse,
    roommates: activeRms,
  });
});

// GET /api/houses/:id/delete-info (Criterio 2)
router.get('/:id/delete-info', async (req, res) => {
  const { id } = req.params;

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id')
    .eq('id', id)
    .maybeSingle();

  if (houseError || !house) {
    return res.status(404).json({ error: 'Esta casa ya no existe', message: 'Esta casa ya no existe' });
  }

  const { data: openPeriod, error: periodError } = await supabase
    .from('periods')
    .select('id')
    .eq('house_id', house.id)
    .eq('is_closed', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (periodError) {
    return res.status(400).json({ error: periodError.message, message: periodError.message });
  }

  let hasPendingDebts = false;
  let debtsCount = 0;

  if (openPeriod) {
    try {
      const { balances, debts } = await calculatePeriodBalances(house.id, openPeriod.id);
      const pendingDebtsList = debts || [];
      const hasBalancePending = (balances || []).some((b) => Math.abs(Number(b.balance) || 0) > 0.01);
      hasPendingDebts = pendingDebtsList.length > 0 || hasBalancePending;
      debtsCount = pendingDebtsList.length;
    } catch {
      // ignore
    }
  }

  return res.status(200).json({ hasPendingDebts, debtsCount });
});

// DELETE /api/houses/:id — Eliminar casa (Criterios 1, 4, 5, 6, 8, 13 y 14)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const userId = req.body?.userId || req.query?.userId || req.headers['x-user-id'];

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id, owner_id')
    .eq('id', id)
    .maybeSingle();

  if (houseError || !house) {
    return res.status(404).json({ error: 'Esta casa ya no existe', message: 'Esta casa ya no existe' });
  }

  // Criterio 1: Solo el creador puede eliminar la casa
  if (!userId || house.owner_id !== userId) {
    return res.status(403).json({
      error: 'Solo el creador puede eliminar la casa',
      message: 'Solo el creador puede eliminar la casa',
    });
  }

  // Consultar roommates de esa casa con user_id no nulo antes de borrar
  const { data: houseRoommates } = await supabase
    .from('roommates')
    .select('user_id')
    .eq('house_id', house.id)
    .not('user_id', 'is', null);

  const memberUserIds = (houseRoommates || [])
    .map((r) => r.user_id)
    .filter((uId) => uId && uId !== house.owner_id);

  // Borrar la casa en Supabase (ON DELETE CASCADE se encarga de las tablas hijas)
  const { error: deleteError } = await supabase
    .from('houses')
    .delete()
    .eq('id', house.id);

  if (deleteError) {
    return res.status(500).json({ error: deleteError.message, message: deleteError.message });
  }

  // Limpiar house.id de user_metadata.joined_houses en Auth para invitados
  for (const mId of memberUserIds) {
    try {
      const { data: memberUser } = await supabase.auth.admin.getUserById(mId);
      if (memberUser?.user) {
        const currentJoined = memberUser.user.user_metadata?.joined_houses;
        if (Array.isArray(currentJoined) && currentJoined.includes(house.id)) {
          const updatedJoined = currentJoined.filter((hId) => hId !== house.id);
          await supabase.auth.admin.updateUserById(mId, {
            user_metadata: {
              ...(memberUser.user.user_metadata || {}),
              joined_houses: updatedJoined,
            },
          });
        }
      }
    } catch {
      // ignore
    }
  }

  return res.status(200).json({
    message: 'Casa eliminada correctamente',
    id: house.id,
  });
});

// POST /api/houses/:id/leave — Salir de la casa (Criterios 1, 11, 12, 13 y 14)
router.post('/:id/leave', async (req, res) => {
  const { id } = req.params;
  const userId = req.body?.userId || req.query?.userId || req.headers['x-user-id'];

  if (!userId) {
    return res.status(401).json({ error: 'userId es requerido', message: 'userId es requerido' });
  }

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('id, owner_id')
    .eq('id', id)
    .maybeSingle();

  if (houseError || !house) {
    return res.status(404).json({ error: 'Esta casa ya no existe', message: 'Esta casa ya no existe' });
  }

  // Criterio 1: Creador no puede salir de la casa
  if (house.owner_id === userId) {
    return res.status(400).json({
      error: 'El creador no puede salir de la casa. Para irte debés eliminar la casa.',
      message: 'El creador no puede salir de la casa. Para irte debés eliminar la casa.',
    });
  }

  // Buscar conviviente activo del usuario en esa casa
  const { data: activeRoommates, error: rmError } = await supabase
    .from('roommates')
    .select('*')
    .eq('house_id', house.id)
    .eq('is_active', true);

  if (rmError) {
    return res.status(400).json({ error: rmError.message, message: rmError.message });
  }

  let roommate = (activeRoommates || []).find((r) => r.user_id && r.user_id === userId);

  if (!roommate) {
    // Fallback por nombre del usuario en Auth
    try {
      const { data: userData } = await supabase.auth.admin.getUserById(userId);
      if (userData?.user) {
        const authName =
          (userData.user.user_metadata?.name && String(userData.user.user_metadata.name).trim().toLowerCase()) ||
          String(userData.user.email || '').split('@')[0].toLowerCase();
        roommate = (activeRoommates || []).find(
          (r) => r.name && r.name.trim().toLowerCase() === authName
        );
      }
    } catch {
      // ignore
    }
  }

  if (!roommate) {
    // Idempotencia para doble clic: si ya no tiene house.id en joined_houses
    const { ids } = await getJoinedHouseIds(userId);
    if (!ids.includes(house.id)) {
      return res.status(200).json({ message: 'Saliste de la casa', alreadyLeft: true, houseId: house.id });
    }
    return res.status(403).json({
      error: 'No sos miembro activo de esta casa',
      message: 'No sos miembro activo de esta casa',
    });
  }

  // Criterio 11 — Validaciones antes de escribir:
  // a) Mínimo 2 convivientes activos
  const activeCount = (activeRoommates || []).length;
  if (activeCount <= 2) {
    return res.status(400).json({
      error: 'La casa necesita al menos dos convivientes',
      message: 'La casa necesita al menos dos convivientes',
    });
  }

  // b) Saldos o deudas pendientes en el período abierto
  const { data: openPeriod, error: periodError } = await supabase
    .from('periods')
    .select('id')
    .eq('house_id', house.id)
    .eq('is_closed', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (periodError) {
    return res.status(400).json({ error: periodError.message, message: periodError.message });
  }

  if (openPeriod) {
    try {
      const { balances, debts } = await calculatePeriodBalances(house.id, openPeriod.id);
      const rmBalanceObj = (balances || []).find((b) => b.id === roommate.id);
      const balanceVal = rmBalanceObj ? Number(rmBalanceObj.balance) : 0;
      const hasPendingBalance = Math.abs(balanceVal) > 0.01;

      const hasPendingDebts = (debts || []).some(
        (d) =>
          d.deudor_id === roommate.id ||
          d.acreedor_id === roommate.id ||
          d.from?.id === roommate.id ||
          d.to?.id === roommate.id
      );

      if (hasPendingBalance || hasPendingDebts) {
        return res.status(400).json({
          error: 'No podés salir de la casa porque tenés saldos o deudas pendientes. Registrá los pagos correspondientes primero',
          message: 'No podés salir de la casa porque tenés saldos o deudas pendientes. Registrá los pagos correspondientes primero',
        });
      }
    } catch (calcErr) {
      return res.status(400).json({ error: calcErr.message, message: calcErr.message });
    }
  }

  // c) Tareas en rotación
  const { data: houseTasks, error: tasksError } = await supabase
    .from('tasks')
    .select('*')
    .eq('house_id', house.id)
    .eq('is_active', true);

  if (tasksError) {
    return res.status(400).json({ error: tasksError.message, message: tasksError.message });
  }

  const activeIdSet = new Set((activeRoommates || []).map((r) => r.id));
  activeIdSet.delete(roommate.id);

  const affectedTasks = [];
  for (const t of houseTasks || []) {
    const ids = Array.isArray(t.roommate_ids) ? t.roommate_ids : [];
    if (ids.includes(roommate.id)) {
      const remainingActiveIds = ids.filter((idItem) => idItem !== roommate.id && activeIdSet.has(idItem));
      if (remainingActiveIds.length < 2) {
        return res.status(400).json({
          error: `No podés salir de la casa porque la tarea "${t.name}" quedaría con menos de dos convivientes. Editá la tarea primero.`,
          message: `No podés salir de la casa porque la tarea "${t.name}" quedaría con menos de dos convivientes. Editá la tarea primero.`,
        });
      }
      affectedTasks.push(t);
    }
  }

  // Criterio 12 — Si pasan todas las validaciones, aplicar cambios:
  // 1. Pase circular en tareas
  for (const t of affectedTasks) {
    const ids = Array.isArray(t.roommate_ids) ? t.roommate_ids : [];
    const idx = ids.indexOf(roommate.id);
    const newIds = ids.filter((idItem) => idItem !== roommate.id);

    let newIndex = t.current_index;
    if (idx < t.current_index) {
      newIndex = t.current_index - 1;
    } else if (idx === t.current_index) {
      newIndex = t.current_index % newIds.length;
    } else if (idx > t.current_index) {
      newIndex = t.current_index;
    }

    const { error: taskUpdateError } = await supabase
      .from('tasks')
      .update({
        roommate_ids: newIds,
        current_index: newIndex,
        updated_at: new Date().toISOString(),
      })
      .eq('id', t.id);

    if (taskUpdateError) {
      return res.status(400).json({ error: taskUpdateError.message, message: taskUpdateError.message });
    }
  }

  // 2. Baja lógica del conviviente
  const { error: rmDeleteError } = await supabase
    .from('roommates')
    .update({
      is_active: false,
      deleted_at: new Date().toISOString(),
    })
    .eq('id', roommate.id);

  if (rmDeleteError) {
    return res.status(400).json({ error: rmDeleteError.message, message: rmDeleteError.message });
  }

  // 3. Quitar house.id de user_metadata.joined_houses del usuario en Auth
  try {
    const { data: memberUser } = await supabase.auth.admin.getUserById(userId);
    if (memberUser?.user) {
      const currentJoined = memberUser.user.user_metadata?.joined_houses;
      if (Array.isArray(currentJoined)) {
        const updatedJoined = currentJoined.filter((hId) => hId !== house.id);
        await supabase.auth.admin.updateUserById(userId, {
          user_metadata: {
            ...(memberUser.user.user_metadata || {}),
            joined_houses: updatedJoined,
          },
        });
      }
    }
  } catch {
    // ignore
  }

  return res.status(200).json({
    message: 'Saliste de la casa correctamente',
    houseId: house.id,
  });
});

module.exports = router;
