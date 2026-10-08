const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: 'Email and password are required',
        error: 'Email and password are required',
      });
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
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

    return res.status(200).json(data.user);
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

  return res.status(200).json({ session: data.session, user: data.user });
});

module.exports = router;
