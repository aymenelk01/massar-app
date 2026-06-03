FROM node:18

# Set node environment to production
ENV NODE_ENV=production

# Set working directory inside the container
WORKDIR /usr/src/app

# Copy package description files
COPY package*.json ./

# Install only production dependencies using npm clean install
RUN npm ci --only=production

# Install MySQL client for database interactions (if needed by the application)
RUN apt-get update && apt-get install -y default-mysql-client && rm -rf /var/lib/apt/lists/*

# Copy the rest of the application files
COPY . .

# Change ownership of the app directory to the node user for security
RUN chown -R node:node /usr/src/app

# Use the non-root node user provided by the base image
USER node

# Expose port 3000 as expected by the ECS Fargate target group and ALB
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
