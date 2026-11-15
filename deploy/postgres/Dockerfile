# TimescaleDB (Postgres 16) with pgBackRest installed, so backups run next to the data directory.
FROM timescale/timescaledb:2.17.2-pg16
USER root
RUN apk add --no-cache pgbackrest tzdata \
  && mkdir -p /etc/pgbackrest /var/log/pgbackrest /var/spool/pgbackrest \
  && chown -R postgres:postgres /etc/pgbackrest /var/log/pgbackrest /var/spool/pgbackrest
COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
RUN chown postgres:postgres /etc/pgbackrest/pgbackrest.conf && chmod 640 /etc/pgbackrest/pgbackrest.conf
# The image's entrypoint drops to the postgres user itself.
