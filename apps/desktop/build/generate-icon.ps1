Add-Type -AssemblyName System.Drawing

$size = 1024
$bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)

function New-RoundedPath([single]$x, [single]$y, [single]$width, [single]$height, [single]$radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Fill-Rounded([System.Drawing.Color]$color, [single]$x, [single]$y, [single]$width, [single]$height, [single]$radius) {
  $brush = [System.Drawing.SolidBrush]::new($color)
  $path = New-RoundedPath $x $y $width $height $radius
  $graphics.FillPath($brush, $path)
  $path.Dispose()
  $brush.Dispose()
}

$background = [System.Drawing.ColorTranslator]::FromHtml('#2B2E3B')
$frame = [System.Drawing.ColorTranslator]::FromHtml('#9FEAF9')
$bars = [System.Drawing.ColorTranslator]::FromHtml('#72D2E6')
$trend = [System.Drawing.ColorTranslator]::FromHtml('#D2F6FC')

Fill-Rounded $background 32 32 960 960 210

$screen = New-RoundedPath 178 220 668 530 52
$screenPen = [System.Drawing.Pen]::new($frame, 42)
$graphics.DrawPath($screenPen, $screen)
$screenPen.Dispose()
$screen.Dispose()

Fill-Rounded $bars 290 575 110 115 12
Fill-Rounded $bars 457 505 110 185 12
Fill-Rounded $bars 624 430 110 260 12

$trendPen = [System.Drawing.Pen]::new($trend, 35)
$trendPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$trendPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$trendPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$trendPoints = [System.Drawing.PointF[]]@(
  [System.Drawing.PointF]::new(290, 530),
  [System.Drawing.PointF]::new(450, 445),
  [System.Drawing.PointF]::new(530, 445),
  [System.Drawing.PointF]::new(730, 330)
)
$graphics.DrawLines($trendPen, $trendPoints)
$trendPen.Dispose()

Fill-Rounded $frame 483 735 58 110 12
Fill-Rounded $frame 365 820 294 52 26

$graphics.Dispose()
$bitmap.Save((Join-Path $PSScriptRoot 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
