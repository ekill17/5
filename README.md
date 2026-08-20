# Puxe o Fio — Doutrina Segundo Cérebro

Aplicação web para estudo encadeado sobre o acervo doutrinário persistido no Airtable.

## Arquitetura

- Airtable: fonte de verdade dos cartões e relações.
- Cloudflare Worker: backend seguro e motor de seleção de próximos cartões.
- Interface web: cartão central, 2–4 caminhos, ponte contextual e trilha percorrida.
- Não expõe token do Airtable no navegador.

## Variáveis

`AIRTABLE_BASE_ID` já está configurado no `wrangler.toml`.

Configurar como segredo do Worker:

- `AIRTABLE_TOKEN`

Configurar como secrets do GitHub Actions para deploy automático:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## Fluxo

1. Abre um cartão (padrão: ANKI-0009).
2. Backend lê o acervo no Airtable.
3. Ranqueia candidatos evitando cartões já visitados.
4. Classifica o caminho como Origem, Aprofundamento, Evolução ou Contraste.
5. Interface exibe até 4 opções.
6. Ao escolher, mostra ponte contextual e abre o próximo cartão.
7. O histórico lateral mantém o fio percorrido.

## Deploy

O workflow `.github/workflows/deploy.yml` executa `wrangler deploy` automaticamente após push em `main`, desde que os secrets externos estejam configurados.

## Segurança

Nunca colocar `AIRTABLE_TOKEN` em `public/`, JavaScript do navegador ou no repositório. O token deve existir apenas como secret no runtime do Worker.
