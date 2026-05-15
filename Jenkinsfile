pipeline {
  agent any

  environment {
    APP_NAME      = 'mobiis-radar-api'
    IMAGE         = "mobiis-radar-api.oconde.dev/${APP_NAME}"
    IMAGE_LATEST  = "${env.IMAGE}:latest"
    HOST_PORT     = '8999'
    CONTAINER_PORT = '3000'
    DATA_VOLUME   = '/srv/mobiis-radar/data'
  }

  stages {
    stage('Getting commitID') {
      steps {
        sh "git rev-parse --short HEAD > commit-id"
      }
    }

    stage('Build Docker Image') {
      environment {
        TAG          = readFile('commit-id').replace('\n', '').replace('\r', '')
        TAGGED_IMAGE = "${env.IMAGE}:${env.TAG}"
      }
      steps {
        echo "Criando imagem: ${env.TAGGED_IMAGE}"
        sh "docker build -t ${env.TAGGED_IMAGE} ."
        sh "docker tag ${env.TAGGED_IMAGE} ${env.IMAGE_LATEST}"
      }
    }

    stage('Deploy') {
      environment {
        TAG          = readFile('commit-id').replace('\n', '').replace('\r', '')
        TAGGED_IMAGE = "${env.IMAGE}:${env.TAG}"
      }
      steps {
        // Garante que o diretório do volume SQLite existe no host
        sh "mkdir -p ${env.DATA_VOLUME}"

        // Para e remove só o container desta app
        sh "docker stop ${APP_NAME} || true"
        sh "docker rm   ${APP_NAME} || true"

        withCredentials([
          string(credentialsId: 'DB_HOST',         variable: 'DB_HOST'),
          string(credentialsId: 'DB_PORT',         variable: 'DB_PORT'),
          string(credentialsId: 'DB_NAME',         variable: 'DB_NAME'),
          string(credentialsId: 'DB_USER',         variable: 'DB_USER'),
          string(credentialsId: 'DB_PASS',         variable: 'DB_PASS'),
          string(credentialsId: 'ANTHROPIC_KEY',   variable: 'ANTHROPIC_API_KEY'),
        ]) {
          sh """
            docker run -d \
              --name ${APP_NAME} \
              --restart unless-stopped \
              -p ${HOST_PORT}:${CONTAINER_PORT} \
              -v ${DATA_VOLUME}:/usr/src/app/data \
              -e DB_HOST=\${DB_HOST} \
              -e DB_PORT=\${DB_PORT} \
              -e DB_NAME=\${DB_NAME} \
              -e DB_USER=\${DB_USER} \
              -e DB_PASS=\${DB_PASS} \
              -e ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY} \
              ${TAGGED_IMAGE}
          """
        }
      }
    }
  }
}
