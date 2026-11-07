# agy account profiles for Windows (run it through the global command:  agys <command>).
# agy keeps its Google login in Windows Credential Manager ("gemini:antigravity"). This tool keeps one saved copy per account
# ("gemini:antigravity:profile:<name>", same store, nothing on disk) and swaps the active one. It never prints secret values;
# the only thing it reads out of a login is the account email.
#   list                 saved agy accounts with emails, which one is active, and which proxy accounts are not saved yet
#   add [name]           sign agy in with another Google account (opens agy: type /logout then /login), then saves it
#   save <name>          save the account agy is currently signed into
#   use <name>           make a saved account the active agy login
#   check                tiny test call per saved account: ok / limited / signed out (restores the active account after)
#   delete <name>        remove a saved account
#   names                machine-readable list of saved names (used by the rotator)
#   proxy                state of the Antigravity proxy accounts (ready, limited, quota)
param([Parameter(Position = 0)][string]$Cmd = 'list', [Parameter(Position = 1)][string]$Name = '')

Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class Cred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment; public long LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string t, uint type, uint f, out IntPtr p);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CREDENTIAL c, uint f);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDeleteW(string t, uint type, uint f);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredEnumerateW(string filter, uint f, out uint count, out IntPtr p);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static bool Copy(string from, string to) {
    IntPtr p; if (!CredReadW(from, 1, 0, out p)) return false;
    try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      c.TargetName = to; c.Flags = 0; c.TargetAlias = null; c.Attributes = IntPtr.Zero; c.AttributeCount = 0; return CredWriteW(ref c, 0);
    } finally { CredFree(p); } }
  public static bool Exists(string t) { IntPtr p; if (!CredReadW(t, 1, 0, out p)) return false; CredFree(p); return true; }
  public static string Stamp(string t) { IntPtr p; if (!CredReadW(t, 1, 0, out p)) return "";
    try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); return DateTime.FromFileTime(c.LastWritten).ToString("MM-dd HH:mm"); } finally { CredFree(p); } }
  // Returns ONLY the account email found in the login (never the tokens).
  public static string Email(string t) { IntPtr p; if (!CredReadW(t, 1, 0, out p)) return "";
    try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); byte[] b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      string s = System.Text.Encoding.UTF8.GetString(b);
      var m = System.Text.RegularExpressions.Regex.Match(s, "\"id_token_email\"\\s*:\\s*\"([^\"]+)\"");
      return m.Success ? m.Groups[1].Value : ""; } finally { CredFree(p); } }
  public static bool Delete(string t) { return CredDeleteW(t, 1, 0); }
  public static string[] List(string filter) { uint n; IntPtr p; var r = new List<string>();
    if (!CredEnumerateW(filter, 0, out n, out p)) return r.ToArray();
    for (int i = 0; i < n; i++) { IntPtr q = Marshal.ReadIntPtr(p, i * IntPtr.Size); CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(q, typeof(CREDENTIAL)); r.Add(c.TargetName); }
    CredFree(p); return r.ToArray(); }
}
'@

$active = 'gemini:antigravity'
$prefix = 'gemini:antigravity:profile:'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Saved { [Cred]::List($prefix + '*') | ForEach-Object { $_.Substring($prefix.Length) } | Where-Object { $_ -and -not $_.StartsWith('.') } | Sort-Object }
function ActiveEmail { [Cred]::Email($active) }
function ProxyEmails {
  $f = Join-Path $HOME '.config\antigravity-proxy\accounts.json'
  if (Test-Path $f) { (Get-Content $f -Raw | ConvertFrom-Json).accounts | ForEach-Object { $_.email } } else { @() }
}
function SavedByEmail($email) { foreach ($n in Saved) { if ([Cred]::Email($prefix + $n) -ieq $email) { return $n } } return $null }

switch ($Cmd) {
  'names' { Saved }
  'list' {
    $ae = ActiveEmail
    "agy is signed in as: " + $(if ($ae) { $ae } else { 'nobody (signed out)' })
    ""
    "SAVED (the rotator uses these):"
    $saved = @(Saved)
    if (-not $saved) { "  none yet. Run: agys add" }
    foreach ($n in $saved) {
      $e = [Cred]::Email($prefix + $n)
      $mark = if ($e -and $e -ieq $ae) { '  <- active now' } else { '' }
      "  {0,-12} {1,-34} saved {2}{3}" -f $n, $(if ($e) { $e } else { '(email unknown)' }), [Cred]::Stamp($prefix + $n), $mark
    }
    $savedEmails = $saved | ForEach-Object { [Cred]::Email($prefix + $_).ToLower() }
    $missing = ProxyEmails | Where-Object { $_ -and ($savedEmails -notcontains $_.ToLower()) }
    ""
    "NOT SAVED YET (accounts in your Antigravity proxy that agy does not have):"
    if ($missing) { $missing | ForEach-Object { "  $_" } } else { "  none, every proxy account is saved" }
  }
  'save' {
    if (-not $Name) { throw 'usage: agys save <name>' }
    $e = ActiveEmail; if (-not $e) { throw 'agy is signed out, nothing to save. Run: agys add' }
    $dup = SavedByEmail $e
    if ($dup -and $dup -ne $Name) { "this account ($e) is already saved as '$dup'. Nothing changed."; break }
    if ([Cred]::Copy($active, $prefix + $Name)) { "saved $e as '$Name'" } else { throw 'could not save' }
  }
  'use' {
    if (-not $Name) { throw 'usage: agys use <name>' }
    if (-not [Cred]::Exists($prefix + $Name)) { throw "no saved account '$Name'. See: agys list" }
    if ([Cred]::Copy($prefix + $Name, $active)) { "agy is now signed in as " + (ActiveEmail) + " ('$Name')" } else { throw 'could not switch' }
  }
  'delete' { if ([Cred]::Delete($prefix + $Name)) { "deleted '$Name'" } else { throw "no saved account '$Name'" } }
  'add' {
    $before = ActiveEmail
    [void][Cred]::Copy($active, $prefix + '.backup')
    ""
    "Opening agy. Do this inside it:"
    "  1. type  /logout   (Enter)"
    "  2. type  /login    (Enter), choose Google OAuth, sign in with the NEW Google account in the browser"
    "  3. when agy shows you are signed in, quit it (Ctrl+C twice, or /exit)"
    "Your current account ($before) stays saved, nothing is lost."
    ""
    & agy
    $e = ActiveEmail
    if (-not $e) { "agy ended signed out. Restoring the previous account."; [void][Cred]::Copy($prefix + '.backup', $active); break }
    $dup = SavedByEmail $e
    if ($dup) { "$e is already saved as '$dup'. Nothing new added."; break }
    $n = if ($Name) { $Name } else { ($e -split '@')[0] -replace '[^\w\-]', '' }
    if ([Cred]::Copy($active, $prefix + $n)) { "saved $e as '$n'. Run: agys list" }
  }
  'check' {
    $keep = ActiveEmail
    [void][Cred]::Copy($active, $prefix + '.backup')
    foreach ($n in Saved) {
      [void][Cred]::Copy($prefix + $n, $active)
      $e = [Cred]::Email($prefix + $n)
      $out = (& agy -p 'reply with the single word OK' --print-timeout 60s 2>&1 | Out-String)
      $state = if ($out -match '(?i)quota|rate.?limit|resource.?exhausted|usage limit|429') { 'LIMITED' } elseif ($out -match '(?i)sign in|not signed in|login') { 'SIGNED OUT' } elseif ($out -match 'OK') { 'ok' } else { 'unknown: ' + $out.Trim().Substring(0, [Math]::Min(60, $out.Trim().Length)) }
      "  {0,-12} {1,-34} {2}" -f $n, $e, $state
    }
    [void][Cred]::Copy($prefix + '.backup', $active)
    "active account restored: " + (ActiveEmail)
  }
  'emails' { foreach ($n in Saved) { "$n`t" + [Cred]::Email($prefix + $n) } }
  'proxy' { node (Join-Path $here 'accounts-status.mjs') }
  'quota' { node (Join-Path $here 'accounts-quota.mjs') $Name }
  'models' {
    "agy is signed in as: " + (ActiveEmail)
    "models agy can use with this account:"
    agy models 2>&1 | Where-Object { $_ -and $_ -notmatch 'Fetching' } | ForEach-Object { '  ' + ($_ -replace "`t", '   ') }
    ""
    "run: agys quota   to see how much of each model is left per account"
  }
  default { "commands: list | add [name] | save <name> | use <name> | check | delete <name> | quota [model] | models | proxy" }
}
