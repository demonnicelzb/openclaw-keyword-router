# 示例：磁盘空间报告（只读脚本，安全）
# 对应 routes.json：
# {
#   "id": "磁盘报告",
#   "match": { "keywords": ["磁盘报告", "还有多少空间"] },
#   "action": { "type": "ps1", "path": "C:\\scripts\\示例-磁盘报告.ps1" },
#   "template": "【磁盘报告】\n{{output}}"
# }

$ErrorActionPreference = 'Stop'

$drives = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null }

foreach ($drive in $drives) {
    $total = $drive.Used + $drive.Free
    if ($total -le 0) { continue }
    $percent = [math]::Round($drive.Used / $total * 100, 1)
    "{0}盘：可用 {1:N1} GB / 共 {2:N1} GB（已用 {3}%）" -f `
        $drive.Name, ($drive.Free / 1GB), ($total / 1GB), $percent
}
