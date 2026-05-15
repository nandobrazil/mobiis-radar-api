pipeline {
  agent any

  environment {
    APP_NAME      = 'mobiis-radar-api'
    IMAGE         = "mobiis-radar-api.oconde.dev/${APP_NAME}"
    IMAGE_LATEST  = "${env.IMAGE}:latest"
    HOST_PORT     = '8999'
    CONTAINER_PORT = '3000'
    DATA_VOLUME   = '/var/lib/jenkins/volumes/mobiis-radar/data'
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

        // Para e remove só o container desta app (ignora erro se não existir)
        sh "docker stop ${APP_NAME} 2>/dev/null || true"
        sh "docker rm   ${APP_NAME} 2>/dev/null || true"

        withCredentials([
          string(credentialsId: 'DB_HOST',         variable: 'DB_HOST'),
          string(credentialsId: 'DB_PORT',         variable: 'DB_PORT'),
          string(credentialsId: 'DB_NAME',         variable: 'DB_NAME'),
          string(credentialsId: 'DB_USER',         variable: 'DB_USER'),
          string(credentialsId: 'DB_PASS',         variable: 'DB_PASS'),
          string(credentialsId: 'AI_PROVIDER',      variable: 'AI_PROVIDER'),
          string(credentialsId: 'ANTHROPIC_TOKEN',  variable: 'ANTHROPIC_TOKEN'),
          string(credentialsId: 'ANTHROPIC_MODELO', variable: 'ANTHROPIC_MODELO'),
          string(credentialsId: 'GEMINI_TOKEN',     variable: 'GEMINI_TOKEN'),
          string(credentialsId: 'GEMINI_MODELO',    variable: 'GEMINI_MODELO'),
          string(credentialsId: 'GPT_TOKEN',        variable: 'GPT_TOKEN'),
          string(credentialsId: 'GPT_MODELO',       variable: 'GPT_MODELO'),
          string(credentialsId: 'ALLOW_NO_CACHE',   variable: 'ALLOW_NO_CACHE'),
          string(credentialsId: 'MOVIDESK_TOKEN',   variable: 'MOVIDESK_TOKEN'),
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
              -e AI_PROVIDER=\${AI_PROVIDER} \
              -e ANTHROPIC_TOKEN=\${ANTHROPIC_TOKEN} \
              -e ANTHROPIC_MODELO=\${ANTHROPIC_MODELO} \
              -e GEMINI_TOKEN=\${GEMINI_TOKEN} \
              -e GEMINI_MODELO=\${GEMINI_MODELO} \
              -e GPT_TOKEN=\${GPT_TOKEN} \
              -e GPT_MODELO=\${GPT_MODELO} \
              -e ALLOW_NO_CACHE=\${ALLOW_NO_CACHE} \
              -e MOVIDESK_TOKEN=\${MOVIDESK_TOKEN} \
              ${TAGGED_IMAGE}
          """
        }
      }
    }
  }
}
