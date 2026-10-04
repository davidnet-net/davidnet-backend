# Tiny image used both by local dev (docker-compose's garage-init service) and the cluster
# (garage-init sidecar on the StatefulSet): the dxflrs/garage image ships only the static
# garage binary with no shell, so we copy it onto alpine to be able to run init.sh.
FROM dxflrs/garage:v2.3.0 AS garage
FROM alpine:3.20
COPY --from=garage /garage /usr/local/bin/garage
COPY init.sh /init.sh
ENTRYPOINT ["/bin/sh", "/init.sh"]
