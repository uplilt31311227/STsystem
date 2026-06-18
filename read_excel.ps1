$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false

$workbook = $excel.Workbooks.Open('C:\Users\uplil\STsystem\schedule.xls')
Write-Output "Sheet count: $($workbook.Worksheets.Count)"

for ($i = 1; $i -le [Math]::Min(5, $workbook.Worksheets.Count); $i++) {
    $sheet = $workbook.Worksheets.Item($i)
    Write-Output "=== $($sheet.Name) ==="
    $usedRange = $sheet.UsedRange
    $rows = $usedRange.Rows.Count
    $cols = $usedRange.Columns.Count
    Write-Output "Range: $rows rows x $cols cols"

    for ($r = 1; $r -le [Math]::Min(15, $rows); $r++) {
        $rowData = @()
        for ($c = 1; $c -le [Math]::Min(12, $cols); $c++) {
            $cellValue = $sheet.Cells.Item($r, $c).Text
            $rowData += $cellValue
        }
        Write-Output ($rowData -join ' | ')
    }
    Write-Output ''
}

$workbook.Close($false)
$excel.Quit()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
