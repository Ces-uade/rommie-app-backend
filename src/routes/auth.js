const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

const deriveName = (email) => String(email || '').split('@')[0];

const resolveName = (user, fallbackEmail) =>
  (user?.user_metadata?.name && String(user.user_metadata.name).trim()) ||
  deriveName(user?.email || fallbackEmail);

router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: 'Email and password are required',
        error: 'Email and password are required',
      });
    }

    const accountName =
      typeof name === 'string' && name.trim().length > 0 ? name.trim() : deriveName(email);

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name: accountName } },
    });

    if (error) {
      const isDuplicate =
        error.code === 'user_already_exists' ||
        error.code === 'email_exists' ||
        /already registered|already exists|already in use|duplicate/i.test(error.message);

      if (isDuplicate) {
        return res.status(400).json({
          message: 'Ese email ya está registrado. Iniciá sesión o usá otro email',
          error: 'Ese email ya está registrado. Iniciá sesión o usá otro email',
        });
      }

      return res.status(400).json({ message: error.message, error: error.message });
    }

    if (data?.user && (!data.user.identities || data.user.identities.length === 0)) {
      return res.status(400).json({
        message: 'Ese email ya está registrado. Iniciá sesión o usá otro email',
        error: 'Ese email ya está registrado. Iniciá sesión o usá otro email',
      });
    }

    return res.status(200).json({
      userId: data.user.id,
      email: data.user.email,
      name: resolveName(data.user, email),
      ...data.user,
    });
  } catch (err) {
    const isDuplicate =
      err?.code === 'user_already_exists' ||
      err?.code === 'email_exists' ||
      /already registered|already exists|already in use|duplicate/i.test(err?.message || '');

    if (isDuplicate) {
      return res.status(400).json({
        message: 'Ese email ya está registrado. Iniciá sesión o usá otro email',
        error: 'Ese email ya está registrado. Iniciá sesión o usá otro email',
      });
    }

    return res.status(400).json({
      message: err?.message || 'Error al registrar el usuario',
      error: err?.message,
    });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json({
    userId: data.user.id,
    email: data.user.email,
    name: resolveName(data.user, email),
    session: data.session,
    user: data.user,
  });
});

module.exports = router;
