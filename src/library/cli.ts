#!/usr/bin/env node
import {enableCompileCache} from 'node:module';

// Cache the command modules before loading them. Failure or explicit opt-out
// leaves normal execution intact; no project or response data is cached here.
enableCompileCache();
await import('./cli-main.ts');
