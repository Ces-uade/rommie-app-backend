const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { calculatePeriodBalances } = require('../utils/calculateBalances');

const resolveHouseOwnerName = async (ownerId) => {
  if (!ownerId) return null;
  try {
    const { data: userData } = await supabase.auth.admin.getUserById(ownerId);
    if (userData?.user) {
      return (
        (userData.user.user_metadata?.name && String(userData.user.user_metadata.name).trim().toLowerCase()) ||
        String(userData.user.email || '').split('@')[0].toLowerCase()
      );
    }
  } catch {
    // ignore
  }
  return null;
};

router.get('/', async (req, res) => {
  const houseId = req.query.houseId || req.query.house_id;

  if (!houseId) {
    return res.status(400).json({ error: 'houseId is required', message: 'houseId is required' });
  }

  // Criterio 7: filtrar convivientes activos
  const { data, error } = await supabase
    .from('roommates')
    .select('*')
    .eq('house_id', houseId)
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  if (error) {
    return res.status(400).json({ error: error.message, message: error.message });
  }

  const roommates = data || [];

  // Obtener house para resolver is_owner
  const { data: house } = await supabase
    .from('houses')
    .select('id, owner_id')
    .eq('id', houseId)
    .maybeSingle();

  const ownerId = house?.owner_id;
  const hasOwnerByUserId = roommates.some((r) => r.user_id && r.user_id === ownerId);

  let ownerName = null;
  if (!hasOwnerByUserId && ownerId) {
    ownerName = await resolveHouseOwnerName(ownerId);
  }

  const enriched = roommates.map((r) => {
    let isOwner = false;
    if (r.user_id && ownerId && r.user_id === ownerId) {
      isOwner = true;
    } else if (!hasOwnerByUserId && ownerName && r.name && r.name.trim().toLowerCase() === ownerName) {
      isOwner = true;
    }
    return {
      ...r,
      is_owner: isOwner,
    };
  });

  return res.status(200).json(enriched);
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

  // Criterio 11: validar duplicados solo entre convivientes activos
  const { data: existingRoommates, error: fetchError } = await supabase
    .from('roommates')
    .select('name')
    .eq('house_id', targetHouseId)
    .eq('is_active', true);

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
    .insert({ house_id: targetHouseId, name: name.trim(), is_active: true })
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

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const userId = req.body?.userId || req.query?.userId || req.headers['x-user-id'];

  // Criterio 13: Buscar roommate y casa
  const { data: roommate, error: rmError } = await supabase
    .from('roommates')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (rmError) {
    return res.status(400).json({ error: rmError.message, message: rmError.message });
  }

  if (!roommate) {
    return res.status(404).json({ error: 'Conviviente no encontrado', message: 'Conviviente no encontrado' });
  }

  const { data: house, error: houseError } = await supabase
    .from('houses')
    .select('*')
    .eq('id', roommate.house_id)
    .maybeSingle();

  if (houseError || !house) {
    return res.status(404).json({ error: 'Casa no encontrada', message: 'Casa no encontrada' });
  }

  // Criterio 14 (Autorización)
  if (!userId || house.owner_id !== userId) {
    return res.status(403).json({
      error: 'Solo el creador de la casa puede eliminar convivientes',
      message: 'Solo el creador de la casa puede eliminar convivientes',
    });
  }

  // Criterio 12 (Idempotencia / doble clic)
  if (roommate.is_active === false) {
    return res.status(200).json({
      message: 'Conviviente eliminado',
      alreadyDeleted: true,
      id: roommate.id,
    });
  }

  // Criterio 2 (No eliminarse a sí mismo)
  const isOwnerByUserId = roommate.user_id && roommate.user_id === house.owner_id;
  let isOwnerByFallback = false;
  if (!isOwnerByUserId) {
    // Verificar si algún otro roommate activo tiene user_id === house.owner_id
    const { data: ownerUserRoommate } = await supabase
      .from('roommates')
      .select('id')
      .eq('house_id', house.id)
      .eq('is_active', true)
      .eq('user_id', house.owner_id)
      .maybeSingle();

    if (!ownerUserRoommate) {
      const ownerName = await resolveHouseOwnerName(house.owner_id);
      if (ownerName && roommate.name && roommate.name.trim().toLowerCase() === ownerName) {
        isOwnerByFallback = true;
      }
    }
  }

  if (isOwnerByUserId || isOwnerByFallback) {
    return res.status(400).json({
      error: 'El creador no puede eliminarse a sí mismo. Para irte debés eliminar la casa.',
      message: 'El creador no puede eliminarse a sí mismo. Para irte debés eliminar la casa.',
    });
  }

  // Criterio 5 (Mínimo 2 activos)
  const { count: activeCount, error: countError } = await supabase
    .from('roommates')
    .select('*', { count: 'exact', head: true })
    .eq('house_id', house.id)
    .eq('is_active', true);

  if (countError) {
    return res.status(400).json({ error: countError.message, message: countError.message });
  }

  if ((activeCount || 0) <= 2) {
    return res.status(400).json({
      error: 'La casa necesita al menos dos convivientes',
      message: 'La casa necesita al menos dos convivientes',
    });
  }

  // Criterio 4 (Saldos o deudas pendientes en período abierto)
  const { data: openPeriod, error: periodError } = await supabase
    .from('periods')
    .select('*')
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
        const errorMsg = `No se puede eliminar a ${roommate.name} porque tiene saldos o deudas pendientes. Registrá los pagos correspondientes primero`;
        return res.status(400).json({ error: errorMsg, message: errorMsg });
      }
    } catch (calcErr) {
      return res.status(400).json({ error: calcErr.message, message: calcErr.message });
    }
  }

  // Criterio 6 (Rotación de tareas < 2)
  const { data: houseTasks, error: tasksError } = await supabase
    .from('tasks')
    .select('*')
    .eq('house_id', house.id);

  if (tasksError) {
    return res.status(400).json({ error: tasksError.message, message: tasksError.message });
  }

  // Obtener IDs de convivientes activos actualmente
  const { data: currentActiveRoommates } = await supabase
    .from('roommates')
    .select('id')
    .eq('house_id', house.id)
    .eq('is_active', true);

  const activeIdSet = new Set((currentActiveRoommates || []).map((r) => r.id));
  activeIdSet.delete(roommate.id);

  const affectedTasks = [];
  for (const t of houseTasks || []) {
    const ids = Array.isArray(t.roommate_ids) ? t.roommate_ids : [];
    if (ids.includes(roommate.id)) {
      const remainingActiveIds = ids.filter((idItem) => idItem !== roommate.id && activeIdSet.has(idItem));
      if (remainingActiveIds.length < 2) {
        const errorMsg = `No se puede eliminar a ${roommate.name} porque la tarea "${t.name}" quedaría con menos de dos convivientes. Editá la tarea primero.`;
        return res.status(400).json({ error: errorMsg, message: errorMsg });
      }
      affectedTasks.push(t);
    }
  }

  // Si pasan todas las validaciones, aplica los cambios:

  // Criterio 8 (Actualizar tareas y pase de turno circular)
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

  // Baja lógica en roommates
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

  // Criterio 10 (Quitar acceso a "Mis casas")
  if (roommate.user_id && roommate.user_id !== house.owner_id) {
    try {
      const { data: memberUser } = await supabase.auth.admin.getUserById(roommate.user_id);
      if (memberUser?.user) {
        const currentJoined = memberUser.user.user_metadata?.joined_houses;
        if (Array.isArray(currentJoined)) {
          const updatedJoined = currentJoined.filter((hId) => hId !== house.id);
          await supabase.auth.admin.updateUserById(roommate.user_id, {
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
    message: 'Conviviente eliminado correctamente',
    id: roommate.id,
  });
});

module.exports = router;
