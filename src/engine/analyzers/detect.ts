// 기술 스택·DB 감지: 빌드 파일, 설정 파일, import 문에서 근거를 모은다.
import type { Analyzer, Ctx } from '../context';
import type { FileInfo, TechHit } from '../types';
import { baseName, makeLineIndex } from '../files';

type Layer = TechHit['layer'];

interface Rule {
  re: RegExp;
  layer: Layer;
  name: string;
  weight?: number;
}

/** 빌드 파일(pom.xml, build.gradle, composer.json, go.mod, package.json, requirements.txt) 의존성 */
const DEP_RULES: Rule[] = [
  { re: /egovframework\.rte|egovframework\.rte\.ptl|<groupId>egovframework/i, layer: '컨트롤러', name: '전자정부 표준프레임워크', weight: 4 },
  { re: /spring-webmvc|spring-boot-starter-web\b|spring-boot-starter-web["':]/i, layer: '컨트롤러', name: 'Spring MVC', weight: 3 },
  { re: /spring-boot-starter/i, layer: '설정', name: 'Spring Boot', weight: 2 },
  { re: /mybatis-spring|org\.mybatis|mybatis-spring-boot-starter|<artifactId>mybatis</i, layer: '데이터 접근', name: 'MyBatis', weight: 3 },
  { re: /ibatis-sqlmap|org\.apache\.ibatis|<artifactId>ibatis/i, layer: '데이터 접근', name: 'iBatis', weight: 3 },
  { re: /hibernate-core|spring-boot-starter-data-jpa|spring-data-jpa|jakarta\.persistence|javax\.persistence/i, layer: '데이터 접근', name: 'JPA·Hibernate', weight: 3 },
  { re: /ojdbc\d*|com\.oracle\.database\.jdbc|oracle\.jdbc/i, layer: 'DB', name: 'Oracle', weight: 3 },
  { re: /mysql-connector|com\.mysql/i, layer: 'DB', name: 'MySQL', weight: 3 },
  { re: /mariadb-java-client|org\.mariadb/i, layer: 'DB', name: 'MariaDB', weight: 3 },
  { re: /postgresql<|org\.postgresql|"pg"\s*:|psycopg/i, layer: 'DB', name: 'PostgreSQL', weight: 3 },
  { re: /mssql-jdbc|com\.microsoft\.sqlserver|sqljdbc/i, layer: 'DB', name: 'MSSQL', weight: 3 },
  { re: /tibero/i, layer: 'DB', name: 'Tibero', weight: 3 },
  { re: /<artifactId>(jstl|javax\.servlet\.jsp|jakarta\.servlet\.jsp)|taglibs-standard|tomcat-embed-jasper/i, layer: '화면', name: 'JSP', weight: 2 },
  { re: /thymeleaf/i, layer: '화면', name: 'Thymeleaf', weight: 3 },
  { re: /tiles-(core|jsp|extras)|apache\.tiles/i, layer: '화면', name: 'Tiles', weight: 2 },
  { re: /freemarker/i, layer: '화면', name: 'FreeMarker', weight: 2 },
  { re: /quartz/i, layer: '배치', name: 'Quartz', weight: 2 },
  { re: /spring-batch|spring-boot-starter-batch/i, layer: '배치', name: 'Spring Batch', weight: 3 },
  // PHP
  { re: /"laravel\/framework"/i, layer: '컨트롤러', name: 'Laravel', weight: 4 },
  { re: /"codeigniter4\/framework"|"codeigniter\/framework"/i, layer: '컨트롤러', name: 'CodeIgniter', weight: 4 },
  { re: /"symfony\/framework-bundle"/i, layer: '컨트롤러', name: 'Symfony', weight: 3 },
  { re: /"illuminate\/database"/i, layer: '데이터 접근', name: 'Eloquent', weight: 2 },
  // Go
  { re: /github\.com\/gin-gonic\/gin/i, layer: '컨트롤러', name: 'Gin', weight: 4 },
  { re: /github\.com\/labstack\/echo/i, layer: '컨트롤러', name: 'Echo', weight: 4 },
  { re: /github\.com\/gofiber\/fiber/i, layer: '컨트롤러', name: 'Fiber', weight: 4 },
  { re: /github\.com\/go-chi\/chi|github\.com\/gorilla\/mux/i, layer: '컨트롤러', name: 'Go 라우터(chi·mux)', weight: 3 },
  { re: /gorm\.io\/gorm|github\.com\/jinzhu\/gorm/i, layer: '데이터 접근', name: 'GORM', weight: 3 },
  { re: /github\.com\/jmoiron\/sqlx/i, layer: '데이터 접근', name: 'sqlx', weight: 3 },
  { re: /github\.com\/go-sql-driver\/mysql|gorm\.io\/driver\/mysql/i, layer: 'DB', name: 'MySQL', weight: 3 },
  { re: /github\.com\/godror\/godror|github\.com\/sijms\/go-ora|github\.com\/mattn\/go-oci8/i, layer: 'DB', name: 'Oracle', weight: 3 },
  { re: /github\.com\/lib\/pq|github\.com\/jackc\/pgx|gorm\.io\/driver\/postgres/i, layer: 'DB', name: 'PostgreSQL', weight: 3 },
  { re: /github\.com\/mattn\/go-sqlite3|gorm\.io\/driver\/sqlite|modernc\.org\/sqlite/i, layer: 'DB', name: 'SQLite', weight: 2 },
  // JS
  { re: /"react"\s*:/, layer: '화면', name: 'React', weight: 3 },
  { re: /"vue"\s*:/, layer: '화면', name: 'Vue', weight: 3 },
  { re: /"@angular\/core"\s*:/, layer: '화면', name: 'Angular', weight: 3 },
  { re: /"next"\s*:/, layer: '화면', name: 'Next.js', weight: 3 },
  { re: /"react-native"\s*:/, layer: '앱', name: 'React Native', weight: 4 },
  { re: /"express"\s*:/, layer: '컨트롤러', name: 'Express', weight: 3 },
  { re: /"@nestjs\/core"\s*:/, layer: '컨트롤러', name: 'NestJS', weight: 3 },
  { re: /"(mysql2?|mariadb)"\s*:/, layer: 'DB', name: 'MySQL', weight: 2 },
  { re: /"oracledb"\s*:/, layer: 'DB', name: 'Oracle', weight: 2 },
  { re: /"(sequelize|typeorm|@prisma\/client|knex|mongoose)"\s*:/, layer: '데이터 접근', name: 'Node ORM', weight: 2 },
  // Python
  { re: /^\s*django\b/im, layer: '컨트롤러', name: 'Django', weight: 4 },
  { re: /^\s*flask\b/im, layer: '컨트롤러', name: 'Flask', weight: 4 },
  { re: /^\s*fastapi\b/im, layer: '컨트롤러', name: 'FastAPI', weight: 4 },
  { re: /^\s*sqlalchemy\b/im, layer: '데이터 접근', name: 'SQLAlchemy', weight: 3 },
  { re: /^\s*(cx[_-]oracle|oracledb)\b/im, layer: 'DB', name: 'Oracle', weight: 3 },
  { re: /^\s*(pymysql|mysqlclient|mysql-connector-python)\b/im, layer: 'DB', name: 'MySQL', weight: 3 },
];

/** 설정 파일(접속 정보·드라이버) */
const CONFIG_RULES: Rule[] = [
  { re: /jdbc:(log4jdbc:)?oracle:|oracle\.jdbc\.(driver\.)?OracleDriver|dbType\s*=\s*oracle|Globals\.DbType\s*=\s*oracle/i, layer: 'DB', name: 'Oracle', weight: 3 },
  { re: /jdbc:(log4jdbc:)?mysql:|com\.mysql(\.cj)?\.jdbc\.Driver|Globals\.DbType\s*=\s*mysql/i, layer: 'DB', name: 'MySQL', weight: 3 },
  { re: /jdbc:(log4jdbc:)?mariadb:|org\.mariadb\.jdbc\.Driver|Globals\.DbType\s*=\s*maria/i, layer: 'DB', name: 'MariaDB', weight: 3 },
  { re: /jdbc:(log4jdbc:)?postgresql:|org\.postgresql\.Driver/i, layer: 'DB', name: 'PostgreSQL', weight: 3 },
  { re: /jdbc:(log4jdbc:)?sqlserver:|com\.microsoft\.sqlserver\.jdbc/i, layer: 'DB', name: 'MSSQL', weight: 3 },
  { re: /jdbc:(log4jdbc:)?tibero:|com\.tmax\.tibero/i, layer: 'DB', name: 'Tibero', weight: 3 },
  { re: /jdbc:(log4jdbc:)?(hsqldb|h2):/i, layer: 'DB', name: 'HSQLDB·H2(내장)', weight: 2 },
  { re: /^\s*DB_CONNECTION\s*=\s*mysql/im, layer: 'DB', name: 'MySQL', weight: 3 },
  { re: /^\s*DB_CONNECTION\s*=\s*mariadb/im, layer: 'DB', name: 'MariaDB', weight: 3 },
  { re: /^\s*DB_CONNECTION\s*=\s*(oracle|oci)/im, layer: 'DB', name: 'Oracle', weight: 3 },
  { re: /^\s*DB_CONNECTION\s*=\s*pgsql/im, layer: 'DB', name: 'PostgreSQL', weight: 3 },
  { re: /\['dbdriver'\]\s*=\s*'mysqli?'|'DBDriver'\s*=>\s*'MySQLi'|DBDriver\s*=\s*MySQLi/i, layer: 'DB', name: 'MySQL', weight: 3 },
  { re: /\['dbdriver'\]\s*=\s*'oci8'|'DBDriver'\s*=>\s*'OCI8'/i, layer: 'DB', name: 'Oracle', weight: 3 },
  { re: /org\.springframework\.web\.servlet\.DispatcherServlet/i, layer: '컨트롤러', name: 'Spring MVC', weight: 3 },
  { re: /<url-pattern>\*\.do<\/url-pattern>/i, layer: '컨트롤러', name: 'Spring MVC', weight: 1 },
  { re: /SqlSessionFactoryBean|SqlSessionTemplate|mybatis\.mapper-locations|mapperLocations/i, layer: '데이터 접근', name: 'MyBatis', weight: 3 },
  { re: /SqlMapClientFactoryBean|sqlMapClient/i, layer: '데이터 접근', name: 'iBatis', weight: 3 },
  { re: /InternalResourceViewResolver|spring\.mvc\.view\.(prefix|suffix)/i, layer: '화면', name: 'JSP', weight: 2 },
  { re: /TilesConfigurer|TilesViewResolver/i, layer: '화면', name: 'Tiles', weight: 2 },
  { re: /egovframework\./i, layer: '컨트롤러', name: '전자정부 표준프레임워크', weight: 1 },
];

/** 소스 import·코드 */
const CODE_RULES: { lang: FileInfo['lang'][]; rules: Rule[] }[] = [
  {
    lang: ['Java', 'Kotlin'],
    rules: [
      { re: /^import\s+egovframework\.(rte|com)\./m, layer: '컨트롤러', name: '전자정부 표준프레임워크', weight: 1 },
      { re: /@Controller\b|@RestController\b/, layer: '컨트롤러', name: 'Spring MVC', weight: 1 },
      { re: /^import\s+org\.apache\.ibatis\.|^import\s+org\.mybatis\.|EgovAbstractMapper|@Mapper\b/m, layer: '데이터 접근', name: 'MyBatis', weight: 1 },
      { re: /EgovAbstractDAO|SqlMapClientDaoSupport|^import\s+com\.ibatis\./m, layer: '데이터 접근', name: 'iBatis', weight: 1 },
      { re: /^import\s+(javax|jakarta)\.persistence\./m, layer: '데이터 접근', name: 'JPA·Hibernate', weight: 1 },
      { re: /@Scheduled\b/, layer: '배치', name: 'Spring 스케줄러', weight: 2 },
      { re: /implements\s+(org\.quartz\.)?Job\b|QuartzJobBean/, layer: '배치', name: 'Quartz', weight: 2 },
      { re: /^import\s+android\./m, layer: '앱', name: 'Android', weight: 2 },
    ],
  },
  {
    lang: ['Go'],
    rules: [
      { re: /"github\.com\/gin-gonic\/gin"/, layer: '컨트롤러', name: 'Gin', weight: 1 },
      { re: /"github\.com\/labstack\/echo(\/v\d)?"/, layer: '컨트롤러', name: 'Echo', weight: 1 },
      { re: /\bhttp\.HandleFunc\(|\bmux\.HandleFunc\(/, layer: '컨트롤러', name: 'net/http', weight: 1 },
      { re: /sql\.Open\(\s*"(mysql)"/, layer: 'DB', name: 'MySQL', weight: 2 },
      { re: /sql\.Open\(\s*"(godror|oracle|oci8)"/, layer: 'DB', name: 'Oracle', weight: 2 },
      { re: /sql\.Open\(\s*"(postgres|pgx)"/, layer: 'DB', name: 'PostgreSQL', weight: 2 },
      { re: /"html\/template"/, layer: '화면', name: 'Go 템플릿', weight: 1 },
    ],
  },
  {
    lang: ['PHP'],
    rules: [
      { re: /\bextends\s+CI_Controller\b|\bextends\s+BaseController\b.*\n?.*CodeIgniter|namespace\s+App\\Controllers;/, layer: '컨트롤러', name: 'CodeIgniter', weight: 2 },
      { re: /\buse\s+Illuminate\\/, layer: '컨트롤러', name: 'Laravel', weight: 1 },
      { re: /\bmysqli_(query|connect)\(|new\s+mysqli\(|new\s+PDO\(\s*['"]mysql:/, layer: 'DB', name: 'MySQL', weight: 2 },
      { re: /\boci_(connect|parse|execute)\(|new\s+PDO\(\s*['"]oci:/, layer: 'DB', name: 'Oracle', weight: 2 },
    ],
  },
];

function isBuildFile(name: string): boolean {
  return ['pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'go.mod', 'package.json', 'requirements.txt', 'pyproject.toml', 'pipfile', 'setup.py'].includes(name.toLowerCase());
}

function isConfigFile(f: FileInfo): boolean {
  const n = f.name.toLowerCase();
  if (n === '.env' || n.startsWith('.env.') || n === 'database.php' || n === 'web.xml') return true;
  if (['Properties', 'YAML'].includes(f.lang)) return true;
  if (f.lang === 'XML' && (/context|servlet|config|spring|mybatis|sqlmap|datasource|application|beans|web|root/i.test(n))) return true;
  if (f.lang === 'PHP' && /\/config\//i.test(f.path)) return true;
  return false;
}

function scan(ctx: Ctx, f: FileInfo, text: string, rules: Rule[]): void {
  const lineOf = makeLineIndex(text);
  for (const r of rules) {
    const m = r.re.exec(text);
    if (m) ctx.hit(r.layer, r.name, f.id, lineOf(m.index), r.weight ?? 1);
  }
}

export const detectAnalyzer: Analyzer = {
  name: 'detect',
  order: 1,
  accepts: () => true,
  analyze(f, text, ctx) {
    const name = baseName(f.path);
    if (isBuildFile(name)) {
      scan(ctx, f, text, DEP_RULES);
      if (name.toLowerCase() === 'pom.xml' || name.toLowerCase().startsWith('build.gradle')) ctx.hit('빌드', name.toLowerCase() === 'pom.xml' ? 'Maven' : 'Gradle', f.id, 1, 2);
      f.layer = 'CONFIG';
      return;
    }
    if (name === 'AndroidManifest.xml') ctx.hit('앱', 'Android', f.id, 1, 4);
    if (name === 'pubspec.yaml' && /\bflutter\s*:/.test(text)) ctx.hit('앱', 'Flutter', f.id, 1, 4);
    if (name === 'artisan' || name === 'artisan.php') ctx.hit('컨트롤러', 'Laravel', f.id, 1, 2);
    if (/(^|\/)system\/core\/CodeIgniter\.php$/.test(f.path)) ctx.hit('컨트롤러', 'CodeIgniter', f.id, 1, 3);
    if (isConfigFile(f)) scan(ctx, f, text, CONFIG_RULES);
    for (const group of CODE_RULES) if (group.lang.includes(f.lang)) scan(ctx, f, text, group.rules);
    if (f.lang === 'JSP') ctx.hit('화면', 'JSP', f.id, 1, 0.2);
    if (f.lang === 'Template' && /\.(gohtml|tmpl)$/.test(f.name)) ctx.hit('화면', 'Go 템플릿', f.id, 1, 0.2);
    if (f.name.endsWith('.blade.php')) ctx.hit('화면', 'Blade', f.id, 1, 0.2);
    if (f.lang === 'JavaScript' && /\$\.ajax\(|\$\.(get|post)\(|jQuery/.test(text)) ctx.hit('화면', 'jQuery', f.id, 1, 0.2);
  },
};
