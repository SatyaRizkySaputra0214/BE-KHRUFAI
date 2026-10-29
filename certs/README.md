# Aiven PostgreSQL CA

Place the CA certificate downloaded from the Aiven PostgreSQL service here as `ca.pem`. In Aiven, open the service **Overview** page, then download **CA Certificate** from **Connection information**. The certificate file is ignored by Git; do not replace it with a server certificate or private key.

`backend/.env` should set `PGSSLROOTCERT=certs/ca.pem`. The backend supplies this CA to node-postgres and keeps certificate and hostname verification enabled. Aiven connections fail early with an explicit setup message if this file is missing.
