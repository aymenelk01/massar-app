# Flyway Migration Runner
# Based on the official Flyway image, which includes the Flyway CLI and Java runtime.
FROM flyway/flyway:11

# Copy migration SQL files into the Flyway default SQL directory
COPY migrations/ /flyway/sql/

# Copy the base configuration (non-sensitive settings only)
# Sensitive values (URL, user, password) are injected at runtime
# by the ECS task definition via environment variables:
#   FLYWAY_URL, FLYWAY_USER, FLYWAY_PASSWORD
COPY conf/flyway.conf /flyway/conf/flyway.conf

# Flyway entrypoint is already defined in the base image.
# Default command runs the 'migrate' command to apply all pending migrations.
CMD ["migrate"] 
