#!/usr/bin/env node
import runtime from './shared/runtime.cjs';
import lifecycle from './shared/lifecycle.cjs';
import {enableCompileCache} from 'node:module';

// Cache the command modules before loading them. Failure or explicit opt-out
// leaves normal execution intact; no project or response data is cached here.
runtime.initialize();
try { await lifecycle.register('cli', {busy: () => true}); }
catch (error:any) { console.error(JSON.stringify({ok:false,error:{code:error.code||'STARTUP',message:error.message}})); process.exit(1); }
enableCompileCache();
await import('./cli-main.ts');
