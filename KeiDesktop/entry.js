process.env.KEI_DESKTOP_MODE = process.env.KEI_LEGACY_DESKTOP === '1' ? 'legacy' : 'independent';
require('./main');
