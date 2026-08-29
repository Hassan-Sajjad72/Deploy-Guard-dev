import dataSource from "./data-source";

dataSource.setOptions({
  migrations: [`${__dirname}/migrations/*.js`],
});

export default dataSource;
