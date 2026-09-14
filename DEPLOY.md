# Publicar a loja GOLD SKULL online

## Antes de subir

1. Troque a senha do admin no painel (o painel exige isso no primeiro login).
2. Gere e defina o `SESSION_SECRET` (o servidor **não sobe** em produção sem ele):
   ```bash
   npm run secret        # copie o valor gerado
   ```
3. Copie `.env.example` para `.env` (ou preencha as variáveis no painel do host).
4. Leve a pasta `data/` para o servidor: ela tem `db.json` (produtos + senhas) e
   `uploads/` (fotos dos produtos e dos sabores). Ela **não** vai no git de propósito.
   Se `data/db.json` não existir, o servidor cria um banco novo a partir de
   `db.seed.json` e imprime uma senha aleatória de primeiro acesso no log.

## Variáveis de ambiente

| Variável | Para que serve |
| --- | --- |
| `SESSION_SECRET` | **Obrigatória em produção.** 32+ caracteres aleatórios. Sem ela dá para forjar sessão de admin. |
| `NODE_ENV=production` | Liga cookie `secure` e mensagens de erro sem detalhes. |
| `FORCE_HTTPS=1` | Redireciona HTTP→HTTPS, liga HSTS e recusa POST em HTTP. |
| `TRUST_PROXY=1` | Número de proxies na frente (Nginx = 1). Sem isso o rate limit vê o IP do proxy e pune todo mundo junto. |
| `DATA_DIR` | Pasta do banco e das fotos. No Railway, se ficar vazio, o servidor usa o volume (`RAILWAY_VOLUME_MOUNT_PATH`). Monte o volume nesse mesmo caminho. |
| `ADMIN_ALLOW_IPS` | Opcional. Lista de IPs que podem abrir `/admin` e as APIs privadas. É a proteção mais forte do painel. |
| `SESSION_IDLE_MIN` / `SESSION_MAX_HOURS` | Tempo de inatividade (120 min) e duração máxima (12 h) da sessão. |
| `LIMIT_LOGIN`, `LIMIT_API`, `LIMIT_WRITE`, `LIMIT_UPLOAD`, `LIMIT_PUBLIC` | Limites de requisição por IP. |
| `AUDIT_MAX_MB` | Tamanho do log antes de rotacionar para `backups/`. |
| `SETUP_ADMIN_PASSWORD` | Só na primeira execução: define a senha inicial em vez de sortear uma. |
| `RESET_ADMIN_PASSWORD` | Redefine a senha do `admin` no próximo boot e zera o 2FA. **Apague depois de entrar.** |

## Opção A — VPS (Hostinger, DigitalOcean, etc.)

```bash
# No servidor
git clone <seu-repo> gold-skull
cd gold-skull
npm ci --omit=dev

# envie a pasta data/ da sua máquina (produtos + fotos), por exemplo:
#   scp -r data usuario@servidor:/caminho/gold-skull/

NODE_ENV=production FORCE_HTTPS=1 TRUST_PROXY=1 \
SESSION_SECRET="cole-a-chave-gerada" PORT=3000 node server.js
```

Use **PM2** ou **systemd** para manter o processo rodando:

```bash
npm install -g pm2
pm2 start server.js --name gold-skull --env production
pm2 save
```

Com PM2, coloque as variáveis num `ecosystem.config.js` ou use `pm2 start --env`.

### Nginx (proxy reverso + HTTPS)

```nginx
server {
  listen 443 ssl http2;
  server_name sualoja.com;

  # certificados do Certbot
  ssl_certificate     /etc/letsencrypt/live/sualoja.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/sualoja.com/privkey.pem;

  client_max_body_size 10M;   # uploads de foto vão até 8 MB

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;   # necessário para FORCE_HTTPS
  }
}
```

Ative o HTTPS com Certbot antes de divulgar o link:
```bash
certbot --nginx -d sualoja.com -d www.sualoja.com
```

## Opção B — Railway ou Render

1. Conecte o repositório Git.
2. Comando de start: `node server.js`
3. Variáveis: `SESSION_SECRET`, `NODE_ENV=production`, `FORCE_HTTPS=1`, `TRUST_PROXY=1`
   (`PORT` a plataforma define sozinha).
4. **Volume persistente** — sem isso você perde produtos, fotos e senhas em cada deploy.
   No Railway, monte o volume (ex.: `/data`). O servidor usa `RAILWAY_VOLUME_MOUNT_PATH`
   automaticamente. Confira no log de partida a linha `[dados] banco: ...`.
5. Esqueceu a senha do admin: defina `RESET_ADMIN_PASSWORD`, faça deploy, entre, **apague** a variável.

Se o log mostrar `PRIMEIRO ACESSO` depois de um deploy, o app criou um banco novo
(volume no caminho errado). Ajuste o mount path e suba de novo — a senha antiga
volta se o `db.json` original estiver no volume.

## Domínio

Aponte o DNS (registro A ou CNAME) para o IP/serviço do host. Ative HTTPS antes de divulgar o link.

## Backup

```bash
npm run backup        # copia data/db.json para backups/db-AAAA-MM-DD.json
```

O que precisa de backup:
- `data/db.json` — produtos, sabores, estoque, usuários
- `data/uploads/` — fotos dos produtos e dos sabores
- `data/audit.jsonl` — logs de auditoria

Recomendado: um cron semanal copiando esses três para fora do servidor.

```cron
0 4 * * 1 cd /caminho/gold-skull && npm run backup
```

## O que já vem protegido

- Rate limit por IP em login, leitura, gravação e upload
- Bloqueio da conta após 8 senhas erradas (15 min, aumentando)
- Sessão amarrada ao navegador, com expiração por inatividade
- Token CSRF + checagem de origem em toda ação que grava
- Upload só aceita JPG/PNG/WEBP/GIF **conferindo os bytes** do arquivo
  (nome original descartado, SVG recusado, arquivos servidos em sandbox)
- CSP estrita, sem script inline; `X-Frame-Options: DENY`
- Senha com scrypt (N=32768) e verificação em tempo constante
- Log de auditoria de todas as ações, com IP e navegador
- Escrita do banco em modo atômico (não corrompe o `db.json`)

## Checklist pós-deploy

- [ ] Loja abre no domínio com HTTPS (cadeado)
- [ ] `https://sualoja.com/admin` pede login e não aparece no Google
- [ ] Senha do admin trocada e anotada em local seguro
- [ ] `SESSION_SECRET` definido (o log de partida não reclama)
- [ ] Upload de foto de produto e de sabor funcionando
- [ ] Pedido abre o WhatsApp com a mensagem correta
- [ ] Aba Logs registrando os acessos
- [ ] Backup agendado e testado
- [ ] `git status` não mostra `data/` nem `backups/`
