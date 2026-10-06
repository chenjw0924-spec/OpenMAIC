param(
  [Parameter(Mandatory = $true)]
  [string]$InputDirectory
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$storageFileType = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$randomAccessStreamType = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage, ContentType=WindowsRuntime]
$bitmapDecoderType = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$softwareBitmapType = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$ocrResultType = [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType=WindowsRuntime]
$languageType = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
$ocrEngineType = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime]
$readModeType = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
  Select-Object -First 1

function Await-WinRT {
  param(
    [Parameter(Mandatory = $true)]$Operation,
    [Parameter(Mandatory = $true)][Type]$ResultType
  )
  $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  return $task.GetAwaiter().GetResult()
}

$language = New-Object $languageType 'zh-Hans-CN'
$engine = $ocrEngineType::TryCreateFromLanguage($language)
if ($null -eq $engine) {
  throw 'Windows zh-Hans-CN OCR engine is unavailable'
}

$rows = @()
Get-ChildItem -LiteralPath $InputDirectory -Filter '*.jpg' | Sort-Object Name | ForEach-Object {
  $path = $_.FullName
  $file = Await-WinRT ($storageFileType::GetFileFromPathAsync($path)) $storageFileType
  $stream = $null
  try {
    $stream = Await-WinRT ($file.OpenAsync($readModeType::Read)) $randomAccessStreamType
    $decoder = Await-WinRT ($bitmapDecoderType::CreateAsync($stream)) $bitmapDecoderType
    $bitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) $softwareBitmapType
    $result = Await-WinRT ($engine.RecognizeAsync($bitmap)) $ocrResultType
    $page = [int]([IO.Path]::GetFileNameWithoutExtension($path) -replace '^page-', '')
    $rows += [pscustomobject]@{ page = $page; text = [string]$result.Text }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

ConvertTo-Json -InputObject $rows -Compress
