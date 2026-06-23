# Flyway Migration Runner
# Based on the official Flyway image, which includes the Flyway CLI and Java runtime.
FROM flyway/flyway:11

# Download the RDS CA bundle from AWS and bake it into the image with correct non-root ownership
ADD --chown=1000:1000 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /flyway/rds-ca.pem

# Copy migration SQL files and enforce non-root ownership (Enforcing Least Privilege)
COPY --chown=1000:1000 migrations/ /flyway/sql/

# Copy the base configuration and enforce non-root ownership
COPY --chown=1000:1000 conf/flyway.conf /flyway/conf/flyway.conf

# Flyway entrypoint is already defined in the base image.
# Default command runs the 'migrate' command to apply all pending migrations.
CMD ["migrate"]