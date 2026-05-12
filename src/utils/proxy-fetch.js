const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

function getProxyEnv(url) {
  if (url.protocol === 'https:') {
    return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  }

  if (url.protocol === 'http:') {
    return process.env.HTTP_PROXY || process.env.http_proxy || '';
  }

  return '';
}

function splitNoProxy(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isNoProxyMatch(hostname, port) {
  const rules = splitNoProxy(process.env.NO_PROXY || process.env.no_proxy);
  const host = String(hostname || '').toLowerCase();
  const hostWithPort = port ? `${host}:${port}` : host;

  return rules.some((rule) => {
    if (rule === '*') {
      return true;
    }

    if (rule === host || rule === hostWithPort) {
      return true;
    }

    if (rule.startsWith('.')) {
      return host.endsWith(rule);
    }

    return host.endsWith(`.${rule}`);
  });
}

function getProxyUrl(url) {
  if (isNoProxyMatch(url.hostname, url.port)) {
    return null;
  }

  const proxyEnv = getProxyEnv(url);
  return proxyEnv ? new URL(proxyEnv) : null;
}

function headersToPlainObject(headers) {
  const output = {};

  if (!headers) {
    return output;
  }

  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      output[key] = value;
    });
    return output;
  }

  return { ...headers };
}

function responseHeadersToHeaders(headers) {
  const output = new Headers();

  Object.entries(headers || {}).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => output.append(key, item));
    } else if (value !== undefined) {
      output.set(key, String(value));
    }
  });

  return output;
}

function collectResponse(response, resolve, reject) {
  const chunks = [];

  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => {
    resolve(new Response(Buffer.concat(chunks), {
      status: response.statusCode || 0,
      statusText: response.statusMessage || '',
      headers: responseHeadersToHeaders(response.headers)
    }));
  });
  response.on('error', reject);
}

function attachAbort(signal, request, reject) {
  if (!signal) {
    return;
  }

  if (signal.aborted) {
    request.destroy();
    reject(new DOMException('The operation was aborted.', 'AbortError'));
    return;
  }

  signal.addEventListener('abort', () => {
    request.destroy(new DOMException('The operation was aborted.', 'AbortError'));
  }, { once: true });
}

function requestDirect(url, options) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: options.method || 'GET',
      headers: headersToPlainObject(options.headers),
      signal: options.signal
    }, (response) => collectResponse(response, resolve, reject));

    request.on('error', reject);
    attachAbort(options.signal, request, reject);
    request.end(options.body || undefined);
  });
}

function requestViaHttpProxy(url, proxyUrl, options) {
  if (url.protocol !== 'https:') {
    const requestUrl = new URL(url.href);
    return new Promise((resolve, reject) => {
      const request = http.request(requestUrl.href, {
        host: proxyUrl.hostname,
        port: proxyUrl.port || 80,
        method: options.method || 'GET',
        headers: headersToPlainObject(options.headers),
        signal: options.signal
      }, (response) => collectResponse(response, resolve, reject));

      request.on('error', reject);
      attachAbort(options.signal, request, reject);
      request.end(options.body || undefined);
    });
  }

  return new Promise((resolve, reject) => {
    const connectRequest = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port || 80,
      method: 'CONNECT',
      path: `${url.hostname}:${url.port || 443}`,
      headers: {
        host: `${url.hostname}:${url.port || 443}`
      },
      signal: options.signal
    });

    connectRequest.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed with HTTP ${response.statusCode}.`));
        return;
      }

      const secureSocket = tls.connect({
        socket,
        servername: url.hostname
      }, () => {
        const request = http.request({
          host: url.hostname,
          port: url.port || 443,
          method: options.method || 'GET',
          path: `${url.pathname}${url.search}`,
          headers: {
            host: url.host,
            ...headersToPlainObject(options.headers)
          },
          createConnection: () => secureSocket,
          signal: options.signal
        }, (httpsResponse) => collectResponse(httpsResponse, resolve, reject));

        request.on('error', reject);
        attachAbort(options.signal, request, reject);
        request.end(options.body || undefined);
      });

      secureSocket.on('error', reject);
    });

    connectRequest.on('error', reject);
    attachAbort(options.signal, connectRequest, reject);
    connectRequest.end();
  });
}

function createProxyAwareFetch(fetchImpl) {
  return function proxyAwareFetch(input, options = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url || input.href);
    const proxyUrl = getProxyUrl(url);

    if (!proxyUrl) {
      return fetchImpl(input, options);
    }

    if (proxyUrl.protocol !== 'http:') {
      return fetchImpl(input, options);
    }

    return requestViaHttpProxy(url, proxyUrl, options);
  };
}

module.exports = {
  createProxyAwareFetch,
  getProxyUrl,
  isNoProxyMatch,
  requestDirect,
  requestViaHttpProxy
};
