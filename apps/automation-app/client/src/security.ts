import { startMonitor } from './monitor.js';
if (typeof document !== 'undefined') startMonitor(document, '/api/security/analysis-view', '[data-analysis-results]');
