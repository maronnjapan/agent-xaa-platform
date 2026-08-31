# Control Plane authentication

`controlPlaneAuth` runs the fixed sequence: authorization scheme, Access Token signature and claims, scope, DPoP presence, DPoP proof, replay detection, key binding, and human-subject binding.

DPoP proof validation follows the cryptographic package order: signature, `typ`, `htm`, `htu`, `iat`, `jti`, and `ath` before `cnf.jkt` binding.
This ordering determines the first observable error when one request violates more than one condition.
