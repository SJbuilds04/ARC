# ARC local voice worker (Windows). Long-lived: reads one JSON request per line on stdin,
# writes one line per request on stdout: "<id> ok <base64 wav>" or "<id> err <message>".
# Text arrives as data on stdin — it is never interpolated into a command.
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$voiceName = $args[0]
$winrt = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $winrt = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
  $pick = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -match $voiceName } | Select-Object -First 1
  if (-not $pick) { $pick = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.Gender -eq "Male" -and $_.Language -like "en*" } | Select-Object -First 1 }
  if ($pick) { $winrt.Voice = $pick }
  $winrt.Options.SpeakingRate = 1.05
  $winrt.Options.AudioPitch = 0.9
  [Console]::Out.WriteLine("ready winrt " + $winrt.Voice.DisplayName)
} catch {
  $winrt = $null
  Add-Type -AssemblyName System.Speech
  $sapi = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try { $sapi.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Male) } catch {}
  [Console]::Out.WriteLine("ready sapi " + $sapi.Voice.Name)
}
[Console]::Out.Flush()

function Invoke-Op($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait() | Out-Null
  return $task.Result
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $id = "?"
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    if ($winrt) {
      $stream = Invoke-Op ($winrt.SynthesizeTextToStreamAsync([string]$req.text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
      $size = [uint32]$stream.Size
      $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
      $null = Invoke-Op ($reader.LoadAsync($size)) ([uint32])
      $bytes = New-Object byte[] $size
      $reader.ReadBytes($bytes)
      $reader.Dispose(); $stream.Dispose()
    } else {
      $ms = New-Object System.IO.MemoryStream
      $sapi.SetOutputToWaveStream($ms)
      $sapi.Speak([string]$req.text)
      $sapi.SetOutputToNull()
      $bytes = $ms.ToArray()
    }
    [Console]::Out.WriteLine("$id ok " + [Convert]::ToBase64String($bytes))
  } catch {
    [Console]::Out.WriteLine("$id err " + ($_.Exception.Message -replace "[\r\n]+", " "))
  }
  [Console]::Out.Flush()
}
