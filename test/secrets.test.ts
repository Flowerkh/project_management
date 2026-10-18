// 접속 정보 가리기 (src/shared/secrets.ts)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSecretFile, maskConnString, redactSecrets } from '../src/shared/secrets';

test('접속 정보 파일 판별', () => {
  for (const p of ['src/main/resources/egovframework/egovProps/globals.properties', '.env', 'config/.env.production', 'jdbc.properties', 'wp-config.php', 'keys/server.pem'])
    assert.equal(isSecretFile(p), true, p);
  for (const p of ['.env.example', 'src/main/java/Foo.java', 'application.yml', 'config/database.php', 'menu.properties'])
    assert.equal(isSecretFile(p), false, p);
});

test('properties: URL·계정·비밀번호를 가리고 나머지는 그대로', () => {
  const src = 'Globals.DbType = oracle\nGlobals.Url=jdbc:oracle:thin:@10.1.2.3:1521:ORCL\nGlobals.UserName = shop_app\nGlobals.Password = s3cr3t!\nGlobals.MainPage = /index.do';
  const r = redactSecrets(src, 'globals.properties');
  assert.equal(r.count, 3);
  assert.match(r.text, /Globals\.Url=jdbc:oracle:thin:@\*\*\*\*/);
  assert.match(r.text, /Globals\.UserName = \*\*\*\*/);
  assert.match(r.text, /Globals\.Password = \*\*\*\*/);
  assert.match(r.text, /Globals\.DbType = oracle/);
  assert.match(r.text, /MainPage = \/index\.do/);
  assert.equal(r.text.split('\n').length, src.split('\n').length);
});

test('yaml·env·xml·php·python·go·java', () => {
  const yml = redactSecrets('spring:\n  datasource:\n    url: jdbc:mariadb://db:3306/shop\n    username: shop_app\n    password: pa55\nserver:\n  port: 8080', 'application.yml');
  assert.equal(yml.count, 3);
  assert.match(yml.text, /port: 8080/);
  const env = redactSecrets('DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USERNAME=root\nDB_PASSWORD=secret', '.env');
  assert.match(env.text, /DB_PORT=3306/);
  assert.doesNotMatch(env.text, /secret|root|127\.0\.0\.1/);
  const xml = redactSecrets('<property name="url" value="jdbc:mysql://10.0.0.5:3306/egov" />\n<property name="password" value="egov1234"/>\n<property name="driverClassName" value="${Globals.DriverClassName}"/>', 'context-datasource.xml');
  assert.doesNotMatch(xml.text, /10\.0\.0\.5|egov1234/);
  assert.match(xml.text, /\$\{Globals\.DriverClassName\}/);
  const php = redactSecrets("'password' => env('DB_PASSWORD', ''),\n$db['default']['password'] = 'hunter2';\ndefine('DB_PASSWORD', 'wp-pass');", 'config.php');
  assert.doesNotMatch(php.text, /hunter2|wp-pass/);
  assert.match(php.text, /env\('DB_PASSWORD', ''\)/);
  const py = redactSecrets("DATABASES = {\n  'default': {\n    'USER': 'root',\n    'PASSWORD': 'django-pw',\n    'HOST': 'db.local',\n  }\n}", 'settings.py');
  assert.doesNotMatch(py.text, /django-pw|db\.local|'root'/);
  const go = redactSecrets('db, err := sql.Open("mysql", "root:pw@tcp(127.0.0.1:3306)/shop")\napiKey := "sk-1"', 'main.go');
  assert.doesNotMatch(go.text, /root:pw|127\.0\.0\.1|sk-1/);
  assert.match(go.text, /apiKey := "\*\*\*\*"/);
  const java = redactSecrets('Connection c = DriverManager.getConnection("jdbc:oracle:thin:@db:1521/ORCL", "scott", "tiger");\nString sql = "SELECT * FROM TB_USER WHERE USER_PW = ?";', 'Dao.java');
  assert.doesNotMatch(java.text, /scott|tiger|@db:1521/);
  assert.match(java.text, /USER_PW = \?/);
});

test('자리표시는 그대로', () => {
  const r = redactSecrets('password=${DB_PASSWORD}\nspring.datasource.password=${SPRING_PW}\nGlobals.Password = ', 'application.properties');
  assert.equal(r.count, 0);
});

test('연결 문자열', () => {
  assert.equal(maskConnString('scott/tiger@db.local:1521/ORCL'), '****/****@****');
  assert.equal(maskConnString('mysql://u:p@h:3306/db'), 'mysql://****');
});
