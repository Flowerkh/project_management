package egovframework.shop.system.service.impl;

import java.util.List;
import org.springframework.stereotype.Repository;
import egovframework.rte.psl.dataaccess.EgovAbstractMapper;
import egovframework.shop.system.service.SysVO;

@Repository("sysdao")
public class SysDAO extends EgovAbstractMapper {

    public Object selectMenuList(SysVO vo) throws Exception {
        return selectList("sysdao.selectMenuList", vo);
    }

    public Object insertMenu(SysVO vo) throws Exception {
        return insert("sysdao.insertMenu", vo);
    }

    public Object deleteMenu(SysVO vo) throws Exception {
        return delete("sysdao.deleteMenu", vo);
    }

    public Object selectCodeList(SysVO vo) throws Exception {
        return selectList("sysdao.selectCodeList", vo);
    }

    public Object mergeCodeDetail(SysVO vo) throws Exception {
        return update("sysdao.mergeCodeDetail", vo);
    }

    public Object selectAdminList(SysVO vo) throws Exception {
        return selectList("sysdao.selectAdminList", vo);
    }

    public Object updateAdminAuth(SysVO vo) throws Exception {
        return update("sysdao.updateAdminAuth", vo);
    }

    public Object selectLoginLogList(SysVO vo) throws Exception {
        return selectList("sysdao.selectLoginLogList", vo);
    }

    public Object selectDynamic(SysVO vo) throws Exception {
        return selectOne("sysdao.selectDynamic", vo);
    }

}
