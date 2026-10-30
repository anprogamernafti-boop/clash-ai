$ErrorActionPreference = 'Stop'

$secureToken = Read-Host 'Jeton Hugging Face temporaire (saisie masquée)' -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
$client = $null
$request = $null
$response = $null
$reader = $null

try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(30)
    $request = [System.Net.Http.HttpRequestMessage]::new(
        [System.Net.Http.HttpMethod]::Get,
        'https://huggingface.co/api/spaces/assernafti/clash-ai-voxcpm-tn/logs/run?tail=100'
    )
    $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token)

    $response = $client.SendAsync(
        $request,
        [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
    ).GetAwaiter().GetResult()

    if (-not $response.IsSuccessStatusCode) {
        $detail = ''
        $bodyTask = $response.Content.ReadAsStringAsync()
        if ($bodyTask.Wait([TimeSpan]::FromSeconds(3))) {
            $detail = [string]$bodyTask.GetAwaiter().GetResult()
        }
        if ($detail.Length -gt 1000) { $detail = $detail.Substring(0, 1000) }
        $detail = $detail -replace 'hf_[A-Za-z0-9]{20,}', 'hf_[REDACTED]'
        $detail = $detail -replace '(?i)Bearer\s+\S+', 'Bearer [REDACTED]'
        throw "Lecture des journaux impossible (HTTP $([int]$response.StatusCode)) : $detail"
    }

    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
    $events = [System.Collections.Generic.List[string]]::new()
    $deadline = [DateTime]::UtcNow.AddSeconds(12)

    while ($events.Count -lt 100 -and [DateTime]::UtcNow -lt $deadline) {
        $readTask = $reader.ReadLineAsync()
        $remaining = [Math]::Max(1, [Math]::Min(2000, ($deadline - [DateTime]::UtcNow).TotalMilliseconds))
        if (-not $readTask.Wait([int]$remaining)) { break }

        try {
            $line = $readTask.GetAwaiter().GetResult()
        } catch {
            break
        }

        if ($null -eq $line) { break }
        if ($line.StartsWith('data:')) {
            $data = $line.Substring(5).TrimStart()
            if ($data -and $data -ne '[DONE]') { $events.Add($data) }
        }
    }

    $logs = $events -join [Environment]::NewLine
    $logs = $logs -replace 'hf_[A-Za-z0-9]{20,}', 'hf_[REDACTED]'
    $logs = $logs -replace '(?i)Bearer\s+\S+', 'Bearer [REDACTED]'

    if (-not $logs.Trim()) {
        Write-Host 'Aucun événement de journal reçu dans les 12 secondes.'
    } else {
        Write-Output $logs
        Write-Host "`nLecture arrêtée proprement ($($events.Count) événement(s), maximum 12 s)."
    }
} finally {
    if ($reader) { $reader.Dispose() }
    if ($response) { $response.Dispose() }
    if ($request) { $request.Dispose() }
    if ($client) { $client.Dispose() }
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    $secureToken.Dispose()
    Remove-Variable token, logs, events, stream, readTask, bodyTask, detail -ErrorAction SilentlyContinue
}
