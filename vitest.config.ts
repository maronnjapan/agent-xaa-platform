import { defineConfig } from 'vitest/config';
import projects from './vitest.workspace.js';

export default defineConfig({ test: { projects } });
