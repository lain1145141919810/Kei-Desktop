if (process.env.KEI_LEGACY_DESKTOP === '1') require('./main');
else require('./standalone/main');
