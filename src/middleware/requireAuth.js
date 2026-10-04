// Shared by every tool: all Drive-backed routes require a signed-in session.
function requireAuth(req, res, next) {
  if (!req.session || !req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated with Google Drive.' });
  }
  next();
}

module.exports = requireAuth;
