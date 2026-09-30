import { afterAll } from 'vitest';
import { removeTempDirs } from './helpers.js';

// Every test file cleans up the temporary projects it created.
afterAll(removeTempDirs);
