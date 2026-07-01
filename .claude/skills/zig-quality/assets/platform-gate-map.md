# Platform Gate Map

```text
macOS native                    OrbStack Linux                  CI Linux
------------                    --------------                  --------
fast edit loop                  local Linux proof               merge proof
verify-fast                     verify-pr                       verify-pr
verify-commit                   zig build fuzz                  coverage-docker
verify-pr structural checks     coverage-linux                  security-scan
Darwin fuzz degradation         coverage-docker                 evals
                                security-scan
```

Authority:

- macOS native: authoring and Darwin regression confidence.
- OrbStack Linux: local Linux fuzz and coverage confidence.
- CI Linux: merge authority.

Never collapse these into one green/red label. Report the exact lane that ran.
