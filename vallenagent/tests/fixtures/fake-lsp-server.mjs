// Minimal LSP server used to prove the client's framing, initialize and diagnostics handling.
const write = payload => {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) break
    const header = buffer.slice(0, headerEnd).toString('ascii')
    const length = Number((header.match(/Content-Length:\s*(\d+)/i) || [])[1] || 0)
    const start = headerEnd + 4
    if (buffer.length < start + length) break
    const message = JSON.parse(buffer.slice(start, start + length).toString('utf8'))
    buffer = buffer.slice(start + length)

    if (message.method === 'initialize') {
      write({ jsonrpc: '2.0', id: message.id, result: { capabilities: { textDocumentSync: 1 } } })
    } else if (message.method === 'textDocument/didOpen') {
      write({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: message.params.textDocument.uri,
          diagnostics: [{
            severity: 1,
            message: 'fake: undefined variable x',
            source: 'fake-lsp',
            range: { start: { line: 2, character: 4 }, end: { line: 2, character: 5 } }
          }]
        }
      })
    } else if (message.method === 'shutdown') {
      write({ jsonrpc: '2.0', id: message.id, result: null })
    }
  }
})
