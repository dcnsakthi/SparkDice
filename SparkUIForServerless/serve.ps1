param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8765
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$files = @{
    '/' = @('index.html', 'text/html; charset=utf-8')
    '/index.html' = @('index.html', 'text/html; charset=utf-8')
    '/profile.js' = @('profile.js', 'text/javascript; charset=utf-8')
    '/app.js' = @('app.js', 'text/javascript; charset=utf-8')
    '/styles.css' = @('styles.css', 'text/css; charset=utf-8')
    '/theme.js' = @('theme.js', 'text/javascript; charset=utf-8')
    '/tests.html' = @('tests.html', 'text/html; charset=utf-8')
    '/tests.js' = @('tests.js', 'text/javascript; charset=utf-8')
    '/query-profile_fc0ea46c-1c1f-4c19-9b35-b95317f026db.json' = @('query-profile_fc0ea46c-1c1f-4c19-9b35-b95317f026db.json', 'application/json')
}
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
try {
    $listener.Start()
    Write-Host "SparkDice is listening at http://localhost:$Port/ (loopback only). Press Ctrl+C to stop."
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        try {
            $response = $context.Response
            $response.Headers['Cache-Control'] = 'no-store'
            $response.Headers['X-Content-Type-Options'] = 'nosniff'
            $response.Headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
            if (!$context.Request.IsLocal) {
                $response.StatusCode = 403
                $body = [Text.Encoding]::UTF8.GetBytes('Local access only.')
            } elseif ($context.Request.HttpMethod -notin @('GET', 'HEAD')) {
                $response.StatusCode = 405
                $response.Headers['Allow'] = 'GET, HEAD'
                $body = [Text.Encoding]::UTF8.GetBytes('Method not allowed.')
            } elseif ($files.ContainsKey($context.Request.Url.AbsolutePath)) {
                $entry = $files[$context.Request.Url.AbsolutePath]
                $path = Join-Path $root $entry[0]
                if (Test-Path -LiteralPath $path -PathType Leaf) {
                    $response.ContentType = $entry[1]
                    $body = [IO.File]::ReadAllBytes($path)
                } else {
                    $response.StatusCode = 404
                    $body = [Text.Encoding]::UTF8.GetBytes('File not found.')
                }
            } else {
                $response.StatusCode = 404
                $body = [Text.Encoding]::UTF8.GetBytes('Not found.')
            }
            $response.ContentLength64 = $body.Length
            if ($context.Request.HttpMethod -ne 'HEAD') {
                $response.OutputStream.Write($body, 0, $body.Length)
            }
        } catch {
            Write-Warning "Request failed: $($_.Exception.Message)"
            $context.Response.Abort()
        } finally {
            $context.Response.Close()
        }
    }
} finally {
    $listener.Close()
}
