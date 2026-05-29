$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false

$workbook = $excel.Workbooks.Open('C:\Users\uplil\STsystem\schedule.xls')
$sheet = $workbook.Worksheets.Item(1)

# Export to CSV with UTF-8 encoding
$csvPath = 'C:\Users\uplil\STsystem\schedule_export.csv'

# Get all data into array
$usedRange = $sheet.UsedRange
$rows = $usedRange.Rows.Count
$cols = $usedRange.Columns.Count

$allData = @()
for ($r = 1; $r -le $rows; $r++) {
    $rowData = @()
    for ($c = 1; $c -le $cols; $c++) {
        $cellValue = $sheet.Cells.Item($r, $c).Text
        if ($cellValue -eq $null) { $cellValue = '' }
        $rowData += $cellValue
    }
    $allData += ($rowData -join ',')
}

# Write with UTF-8 BOM
$allData | Out-File -FilePath $csvPath -Encoding UTF8

Write-Output "Exported $rows rows to $csvPath"

$workbook.Close($false)
$excel.Quit()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
