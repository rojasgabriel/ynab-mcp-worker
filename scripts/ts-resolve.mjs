// Lets Node's built-in type stripping load the Worker sources directly.
// The sources import siblings as "./x.js" (what tsc/wrangler expect); on disk
// they are "./x.ts", so retry a missing relative .js import as .ts.
// Usage: node --experimental-strip-types --import ./scripts/ts-resolve.mjs <script>
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) {
        return next(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
});
