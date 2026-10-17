package egovframework.shop.main.service.impl;

import org.springframework.stereotype.Repository;
import egovframework.rte.psl.dataaccess.EgovAbstractMapper;

@Repository("loginDAO")
public class LoginDAO extends EgovAbstractMapper {
    public Object selectAdmin(String adminId) {
        return selectOne("loginDAO.selectAdmin", adminId);
    }
    public int insertLoginLog(String adminId) {
        return insert("loginDAO.insertLoginLog", adminId);
    }
}
