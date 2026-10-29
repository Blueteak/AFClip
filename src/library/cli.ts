#!/usr/bin/env node
import runtime from '../shared/runtime.cjs';
import lifecycle from '../shared/lifecycle.cjs';
import {enableCompileCache} from 'node:module';

// Cache the command modules before loading them. Failure or explicit opt-out
// leaves normal execution intact; no project or response data is cached here.
runtime.initialize();
await lifecycle.register('cli', {busy: () => true});
enableCompileCache();
await import('./cli-main.ts');
