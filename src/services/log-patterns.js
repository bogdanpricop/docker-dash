'use strict';

/**
 * Log Pattern Matching Engine
 * Matches common error patterns in container logs to provide
 * structured diagnoses and actionable suggestions.
 */

const PATTERNS = [
  // ── Memory ────────────────────────────
  { regex: /killed process \d+.*oom|out of memory|oom-kill|oom_kill|cannot allocate memory|memory allocation failed/i, category: 'memory', severity: 'critical', title: 'Out of Memory (OOM) Kill', explanation: 'The process was killed by the kernel OOM killer because it exceeded memory limits.', fixes: ['Increase container memory limit', 'Optimize application memory usage', 'Add swap space or memory reservation', 'Check for memory leaks in application'] },
  { regex: /java\.lang\.OutOfMemoryError|heap space|GC overhead limit/i, category: 'memory', severity: 'critical', title: 'Java Heap Space Exhausted', explanation: 'Java application ran out of heap memory.', fixes: ['Increase -Xmx JVM heap size', 'Increase container memory limit accordingly', 'Profile application for memory leaks', 'Check -XX:MaxRAMPercentage if using container-aware JVM'] },
  { regex: /FATAL ERROR: .* JavaScript heap out of memory|allocation failed.*process out of memory/i, category: 'memory', severity: 'critical', title: 'Node.js Heap Exhausted', explanation: 'Node.js ran out of V8 heap memory.', fixes: ['Increase --max-old-space-size flag', 'Increase container memory limit', 'Check for memory leaks (growing arrays, event listeners, closures)', 'Use Node.js --inspect to profile memory'] },

  // ── Network ───────────────────────────
  { regex: /connection refused|ECONNREFUSED|connect: connection refused/i, category: 'network', severity: 'warning', title: 'Connection Refused', explanation: 'Application tried to connect to a service that is not listening on the target port.', fixes: ['Verify the target service is running', 'Check hostname/port configuration in environment variables', 'Ensure containers are on the same Docker network', 'Check if the service port is correctly exposed'] },
  { regex: /name or service not known|EAI_AGAIN|ENOTFOUND|could not resolve host|dns.*failed|getaddrinfo/i, category: 'network', severity: 'warning', title: 'DNS Resolution Failed', explanation: 'Cannot resolve a hostname to an IP address.', fixes: ['Verify the hostname is correct', 'Check Docker DNS configuration (--dns flag)', 'Ensure target container name matches hostname used', 'Check if containers share a Docker network'] },
  { regex: /connection timed out|ETIMEDOUT|ESOCKETTIMEDOUT|connect timed out/i, category: 'network', severity: 'warning', title: 'Connection Timeout', explanation: 'Connection attempt timed out waiting for response.', fixes: ['Check if target service is overloaded or slow', 'Verify firewall rules allow the connection', 'Increase connection timeout settings', 'Check network latency between containers'] },
  { regex: /connection reset by peer|ECONNRESET|broken pipe|EPIPE/i, category: 'network', severity: 'warning', title: 'Connection Reset', explanation: 'The remote end forcefully closed the connection.', fixes: ['Check if the target service crashed or restarted', 'Verify keep-alive settings', 'Check for proxy/load balancer timeouts', 'Increase idle connection timeout'] },
  { regex: /SSL.*error|TLS.*error|certificate.*expired|certificate.*invalid|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS/i, category: 'network', severity: 'warning', title: 'TLS/SSL Certificate Error', explanation: 'SSL/TLS handshake or certificate validation failed.', fixes: ['Check if SSL certificates are expired', 'Update CA certificates in container', 'Set NODE_TLS_REJECT_UNAUTHORIZED=0 for testing only', 'Mount updated certificates into the container'] },

  // ── Filesystem ────────────────────────
  { regex: /permission denied|EACCES|operation not permitted|EPERM/i, category: 'filesystem', severity: 'warning', title: 'Permission Denied', explanation: 'The process lacks permission to access a file or resource.', fixes: ['Check file ownership and permissions on mounted volumes', 'Run container with correct user (--user flag)', 'Verify volume mount permissions', 'Check if SELinux/AppArmor is blocking access (:z/:Z flags)'] },
  { regex: /no space left on device|ENOSPC|disk.*full/i, category: 'filesystem', severity: 'critical', title: 'Disk Full', explanation: 'No disk space remaining on the filesystem.', fixes: ['Run docker system prune to free space', 'Increase disk size or add storage', 'Check for large log files inside the container', 'Configure log rotation (--log-opt max-size)'] },
  { regex: /read-only file system|EROFS/i, category: 'filesystem', severity: 'warning', title: 'Read-Only Filesystem', explanation: 'Attempting to write to a read-only filesystem.', fixes: ['Check if volume is mounted read-only (:ro)', 'Verify container is not running with --read-only flag', 'Write to /tmp or a writable volume instead'] },
  { regex: /no such file or directory|ENOENT|file not found|path not found/i, category: 'filesystem', severity: 'warning', title: 'File Not Found', explanation: 'A required file or directory does not exist.', fixes: ['Verify volume mounts point to correct host paths', 'Check if required config files are present in the image', 'Ensure init scripts create needed directories', 'Check working directory (WORKDIR) in Dockerfile'] },

  // ── Database ──────────────────────────
  { regex: /access denied for user|authentication failed|password authentication failed|login failed/i, category: 'database', severity: 'critical', title: 'Database Authentication Failed', explanation: 'Cannot authenticate to the database with provided credentials.', fixes: ['Verify database username and password in environment variables', 'Check if the database user has been created', 'Reset database password if needed', 'Check if database allows connections from container network'] },
  { regex: /too many connections|max_connections|connection pool exhausted|EPOOL/i, category: 'database', severity: 'warning', title: 'Database Connection Pool Exhausted', explanation: 'All available database connections are in use.', fixes: ['Increase max_connections in database config', 'Reduce connection pool size in application', 'Check for connection leaks (connections not being returned)', 'Consider using connection pooling middleware (PgBouncer, ProxySQL)'] },
  { regex: /deadlock|lock wait timeout|LOCK_TIMEOUT/i, category: 'database', severity: 'warning', title: 'Database Deadlock', explanation: 'Two or more transactions are blocking each other.', fixes: ['Review transaction isolation levels', 'Keep transactions short', 'Access tables in consistent order', 'Add retry logic for deadlocked transactions'] },
  { regex: /table.*doesn.t exist|relation.*does not exist|unknown table|no such table/i, category: 'database', severity: 'critical', title: 'Missing Database Table', explanation: 'A required database table or relation does not exist.', fixes: ['Run database migrations', 'Check if database was properly initialized', 'Verify database name in connection string', 'Check schema permissions for the database user'] },

  // ── Web Server ────────────────────────
  { regex: /502 bad gateway|upstream.*connect.*failed|upstream prematurely closed/i, category: 'webserver', severity: 'warning', title: 'Nginx/Proxy 502 Bad Gateway', explanation: 'The reverse proxy cannot reach the upstream application.', fixes: ['Verify the upstream application is running', 'Check upstream host and port in nginx config', 'Increase proxy_read_timeout and proxy_connect_timeout', 'Check if application is listening on the correct interface (0.0.0.0 vs 127.0.0.1)'] },
  { regex: /504 gateway timeout|upstream timed out/i, category: 'webserver', severity: 'warning', title: 'Gateway Timeout (504)', explanation: 'The upstream server did not respond in time.', fixes: ['Increase proxy timeout values', 'Optimize slow backend operations', 'Add caching for expensive requests', 'Check if backend is overloaded'] },
  { regex: /address already in use|EADDRINUSE|bind.*failed/i, category: 'webserver', severity: 'critical', title: 'Port Already In Use', explanation: 'Another process is already listening on the required port.', fixes: ['Check for duplicate containers using the same port', 'Stop the conflicting container or change port mapping', 'Use docker ps to find what is using the port', 'Change application listen port via environment variable'] },

  // ── Runtime ───────────────────────────
  { regex: /segmentation fault|segfault|SIGSEGV|core dumped/i, category: 'runtime', severity: 'critical', title: 'Segmentation Fault', explanation: 'The application crashed due to invalid memory access.', fixes: ['Update the application/image to latest version', 'Check if running on compatible architecture (amd64 vs arm64)', 'Enable core dumps for debugging', 'Report bug to the application maintainer'] },
  { regex: /Traceback \(most recent call last\)|ModuleNotFoundError|ImportError/i, category: 'runtime', severity: 'warning', title: 'Python Error', explanation: 'Python application encountered an unhandled exception or missing module.', fixes: ['Install missing Python packages (pip install)', 'Check requirements.txt is complete', 'Verify Python version compatibility', 'Check PYTHONPATH environment variable'] },
  { regex: /unhandled.*rejection|UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/i, category: 'runtime', severity: 'warning', title: 'Node.js Unhandled Promise Rejection', explanation: 'A Promise rejection was not caught in the application.', fixes: ['Add .catch() handlers to all Promise chains', 'Use try/catch with async/await', 'Add process.on("unhandledRejection") handler', 'Update Node.js (newer versions crash on unhandled rejections)'] },
  { regex: /exec format error|cannot execute binary file/i, category: 'runtime', severity: 'critical', title: 'Wrong Architecture', explanation: 'Binary was built for a different CPU architecture.', fixes: ['Pull the correct image for your architecture (linux/amd64, linux/arm64)', 'Use docker buildx for multi-arch builds', 'Check image platform compatibility', 'Install QEMU for cross-platform emulation'] },
  { regex: /killed|signal: killed|signal 9|exit code: 137/i, category: 'runtime', severity: 'warning', title: 'Process Killed (Signal 9)', explanation: 'Process was forcefully killed, usually by OOM killer or docker stop timeout.', fixes: ['Check if container hit memory limit', 'Increase stop_grace_period for graceful shutdown', 'Check host memory usage', 'Add health check to detect hung processes'] },
  { regex: /exit code: 1|exited with code 1/i, category: 'runtime', severity: 'info', title: 'Application Error (Exit 1)', explanation: 'Application exited with generic error code.', fixes: ['Check application logs for specific error messages', 'Verify all required environment variables are set', 'Check configuration file syntax', 'Try running the command manually inside the container'] },

  // ── Redis ─────────────────────────────
  { regex: /redis.*timeout|NOAUTH|WRONGPASS|redis.*connection refused/i, category: 'database', severity: 'warning', title: 'Redis Connection Error', explanation: 'Cannot connect to Redis or authentication failed.', fixes: ['Verify Redis host and port in configuration', 'Check REDIS_PASSWORD environment variable', 'Ensure Redis container is running and healthy', 'Check if Redis requirepass is set'] },

  // ── General ───────────────────────────
  { regex: /panic:|goroutine \d+/i, category: 'runtime', severity: 'critical', title: 'Go Panic', explanation: 'Go application encountered an unrecoverable error.', fixes: ['Check the stack trace for the failing function', 'Update the application to latest version', 'Report bug with the panic trace', 'Add recover() handlers in critical paths'] },
  { regex: /stack overflow|maximum call stack size exceeded/i, category: 'runtime', severity: 'critical', title: 'Stack Overflow', explanation: 'Infinite recursion or deep call stack exceeded the limit.', fixes: ['Check for infinite recursion in code', 'Increase stack size if legitimate deep recursion', 'Convert recursive algorithms to iterative', 'Check for circular dependencies'] },
];

/**
 * Analyze log text against known patterns
 * @param {string} logText - Raw log text to analyze
 * @returns {{ patterns: Array, severity: string, diagnosis: string }}
 */
function analyzeLog(logText) {
  if (!logText || typeof logText !== 'string') {
    return { patterns: [], severity: 'ok', diagnosis: 'No log content to analyze.' };
  }

  const lines = logText.split('\n');
  const matched = [];
  const seen = new Set();

  for (const pattern of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (pattern.regex.test(lines[i])) {
        const key = pattern.title;
        if (!seen.has(key)) {
          seen.add(key);
          matched.push({
            ...pattern,
            matchedLine: lines[i].substring(0, 200).trim(),
            lineNumber: i + 1,
          });
        }
        break; // One match per pattern is enough
      }
    }
  }

  // Determine overall severity
  let severity = 'ok';
  if (matched.some(m => m.severity === 'critical')) severity = 'critical';
  else if (matched.some(m => m.severity === 'warning')) severity = 'warning';
  else if (matched.some(m => m.severity === 'info')) severity = 'info';

  // Generate diagnosis text
  let diagnosis = '';
  if (matched.length === 0) {
    diagnosis = 'No known error patterns detected in the logs. The container appears to be functioning normally.';
  } else {
    const critCount = matched.filter(m => m.severity === 'critical').length;
    const warnCount = matched.filter(m => m.severity === 'warning').length;
    diagnosis = `Found ${matched.length} issue(s): ${critCount} critical, ${warnCount} warning(s). `;
    diagnosis += matched.map(m => m.title).join(', ') + '.';
  }

  return {
    patterns: matched.map(m => ({
      category: m.category,
      severity: m.severity,
      title: m.title,
      explanation: m.explanation,
      fixes: m.fixes,
      matchedLine: m.matchedLine,
      lineNumber: m.lineNumber,
    })),
    severity,
    diagnosis,
  };
}

/**
 * Generate an AI prompt with container context for external LLM
 */
function generateAIPrompt(containerInfo, diagnoseResult, logAnalysis, logText) {
  const sections = [];

  sections.push('# Container Diagnosis Report');
  sections.push('');
  sections.push('## Container Details');
  sections.push(`- **Name:** ${containerInfo.name || 'unknown'}`);
  sections.push(`- **Image:** ${containerInfo.image || 'unknown'}`);
  sections.push(`- **Status:** ${containerInfo.stateStatus || 'unknown'}`);
  if (containerInfo.restartPolicy) sections.push(`- **Restart Policy:** ${containerInfo.restartPolicy}`);
  if (containerInfo.memoryLimit) sections.push(`- **Memory Limit:** ${containerInfo.memoryLimit}`);
  sections.push('');

  if (diagnoseResult?.steps?.length) {
    sections.push('## Diagnostic Checks');
    for (const step of diagnoseResult.steps) {
      sections.push(`- **${step.title}:** ${step.status.toUpperCase()} — ${step.detail}`);
      if (step.suggestion) sections.push(`  - Suggestion: ${step.suggestion}`);
    }
    sections.push('');
  }

  if (logAnalysis?.patterns?.length) {
    sections.push('## Detected Log Patterns');
    for (const p of logAnalysis.patterns) {
      sections.push(`- **[${p.severity.toUpperCase()}] ${p.title}** (${p.category})`);
      sections.push(`  - ${p.explanation}`);
      sections.push(`  - Matched: \`${p.matchedLine}\``);
    }
    sections.push('');
  }

  if (logText) {
    const trimmed = logText.split('\n').slice(-50).join('\n');
    sections.push('## Recent Logs (last 50 lines)');
    sections.push('```');
    sections.push(trimmed);
    sections.push('```');
    sections.push('');
  }

  sections.push('## Question');
  sections.push('Based on the above container diagnostics, log analysis, and recent logs, please:');
  sections.push('1. Identify the root cause of any issues');
  sections.push('2. Provide specific, actionable fix steps');
  sections.push('3. Suggest any preventive measures');
  sections.push('4. Rate the overall health risk (Low/Medium/High/Critical)');

  return sections.join('\n');
}

module.exports = { analyzeLog, generateAIPrompt, PATTERNS };
